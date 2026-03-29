Dockerfile
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 8080;

// Backend server URL - configure this
const BACKEND_SERVER_URL = process.env.BACKEND_SERVER_URL || 'https://ocr-backend.zeabur.app';

// Middleware
app.use(cors());
app.use(express.json());

// Create upload and results directories
const uploadsDir = path.join(__dirname, 'uploads');
const resultsDir = path.join(__dirname, 'results');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// In-memory job tracking
const jobs = new Map();

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'OCR Application for PDF',
    version: '1.0.0',
    status: 'running',
    backendServer: BACKEND_SERVER_URL,
    endpoints: {
      health: '/api/health',
      upload: 'POST /api/ocr',
      status: 'GET /api/ocr/:jobId/status',
      result: 'GET /api/ocr/:jobId/result',
      download: 'GET /api/ocr/:jobId/download'
    }
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Helper function to upload result to backend server
async function uploadToBackend(resultData, resultFileName) {
  try {
    const resultPath = path.join(resultsDir, resultFileName);
    
    const formData = new FormData();
    formData.append('file', fs.createReadStream(resultPath));
    formData.append('metadata', JSON.stringify({
      jobId: resultData.jobId,
      fileName: resultData.fileName,
      pageCount: resultData.pageCount,
      textLength: resultData.textLength,
      processedAt: resultData.processedAt,
      processingTime: resultData.processingTime
    }));

    const response = await axios.post(`${BACKEND_SERVER_URL}/upload`, formData, {
      headers: formData.getHeaders(),
      timeout: 30000
    });

    console.log(`Successfully uploaded result ${resultData.jobId} to backend:`, response.data);
    return response.data;
  } catch (error) {
    console.error(`Failed to upload result to backend:`, error.message);
    // Don't throw - allow local storage to work even if backend is unavailable
    return null;
  }
}

// Upload and process PDF
app.post('/api/ocr', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const jobId = uuidv4();
    const filePath = req.file.path;

    // Initialize job
    jobs.set(jobId, {
      status: 'processing',
      progress: 0,
      startTime: Date.now(),
      fileName: req.file.originalname
    });

    // Process PDF asynchronously
    (async () => {
      try {
        // Extract text from PDF
        const pdfBuffer = fs.readFileSync(filePath);
        const pdfData = await pdfParse(pdfBuffer);
        
        let extractedText = pdfData.text;
        const pageCount = pdfData.numpages;

        // If PDF has low text content, use OCR
        if (extractedText.trim().length < 100) {
          jobs.set(jobId, { ...jobs.get(jobId), status: 'ocr_processing', progress: 50 });
          
          const result = await Tesseract.recognize(filePath, 'eng');
          extractedText = result.data.text;
        }

        // Save results locally
        const resultFileName = `${jobId}.json`;
        const resultPath = path.join(resultsDir, resultFileName);
        
        const resultData = {
          jobId,
          fileName: req.file.originalname,
          pageCount,
          textLength: extractedText.length,
          text: extractedText,
          processedAt: new Date().toISOString(),
          processingTime: Date.now() - jobs.get(jobId).startTime
        };

        fs.writeFileSync(resultPath, JSON.stringify(resultData, null, 2));

        // Upload to backend server
        jobs.set(jobId, { ...jobs.get(jobId), status: 'uploading_to_backend', progress: 90 });
        const backendResponse = await uploadToBackend(resultData, resultFileName);

        // Update job status
        jobs.set(jobId, {
          status: 'completed',
          progress: 100,
          resultFile: resultFileName,
          backendUpload: backendResponse ? 'success' : 'local_only',
          completedAt: new Date().toISOString(),
          processingTime: Date.now() - jobs.get(jobId).startTime
        });

        // Clean up uploaded file
        fs.unlinkSync(filePath);

      } catch (error) {
        console.error(`Error processing job ${jobId}:`, error);
        jobs.set(jobId, {
          status: 'failed',
          error: error.message,
          failedAt: new Date().toISOString()
        });
      }
    })();

    res.json({
      jobId,
      status: 'processing',
      message: 'File uploaded. Processing started.',
      statusUrl: `/api/ocr/${jobId}/status`,
      resultUrl: `/api/ocr/${jobId}/result`
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check job status
app.get('/api/ocr/:jobId/status', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json({
    jobId,
    status: job.status,
    progress: job.progress,
    processingTime: job.processingTime,
    backendUpload: job.backendUpload || null,
    error: job.error || null
  });
});

// Get job result
app.get('/api/ocr/:jobId/result', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status !== 'completed') {
    return res.status(400).json({ error: `Job is ${job.status}` });
  }

  try {
    const resultPath = path.join(resultsDir, job.resultFile);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve result' });
  }
});

// Download result as file
app.get('/api/ocr/:jobId/download', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job || job.status !== 'completed') {
    return res.status(404).json({ error: 'Result not found or not ready' });
  }

  try {
    const resultPath = path.join(resultsDir, job.resultFile);
    res.download(resultPath, `ocr-result-${jobId}.json`);
  } catch (error) {
    res.status(500).json({ error: 'Failed to download result' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`OCR Application running on port ${PORT}`);
  console.log(`Backend server: ${BACKEND_SERVER_URL}`);
});
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 8080;

// Backend server URL - configure this
const BACKEND_SERVER_URL = process.env.BACKEND_SERVER_URL || 'https://ocr-backend.zeabur.app';

// Middleware
app.use(cors());
app.use(express.json());

// Create upload and results directories
const uploadsDir = path.join(__dirname, 'uploads');
const resultsDir = path.join(__dirname, 'results');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// In-memory job tracking
const jobs = new Map();

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'OCR Application for PDF',
    version: '1.0.0',
    status: 'running',
    backendServer: BACKEND_SERVER_URL,
    endpoints: {
      health: '/api/health',
      upload: 'POST /api/ocr',
      status: 'GET /api/ocr/:jobId/status',
      result: 'GET /api/ocr/:jobId/result',
      download: 'GET /api/ocr/:jobId/download'
    }
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Helper function to upload result to backend server
async function uploadToBackend(resultData, resultFileName) {
  try {
    const resultPath = path.join(resultsDir, resultFileName);
    
    const formData = new FormData();
    formData.append('file', fs.createReadStream(resultPath));
    formData.append('metadata', JSON.stringify({
      jobId: resultData.jobId,
      fileName: resultData.fileName,
      pageCount: resultData.pageCount,
      textLength: resultData.textLength,
      processedAt: resultData.processedAt,
      processingTime: resultData.processingTime
    }));

    const response = await axios.post(`${BACKEND_SERVER_URL}/upload`, formData, {
      headers: formData.getHeaders(),
      timeout: 30000
    });

    console.log(`Successfully uploaded result ${resultData.jobId} to backend:`, response.data);
    return response.data;
  } catch (error) {
    console.error(`Failed to upload result to backend:`, error.message);
    // Don't throw - allow local storage to work even if backend is unavailable
    return null;
  }
}

// Upload and process PDF
app.post('/api/ocr', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const jobId = uuidv4();
    const filePath = req.file.path;

    // Initialize job
    jobs.set(jobId, {
      status: 'processing',
      progress: 0,
      startTime: Date.now(),
      fileName: req.file.originalname
    });

    // Process PDF asynchronously
    (async () => {
      try {
        // Extract text from PDF
        const pdfBuffer = fs.readFileSync(filePath);
        const pdfData = await pdfParse(pdfBuffer);
        
        let extractedText = pdfData.text;
        const pageCount = pdfData.numpages;

        // If PDF has low text content, use OCR
        if (extractedText.trim().length < 100) {
          jobs.set(jobId, { ...jobs.get(jobId), status: 'ocr_processing', progress: 50 });
          
          const result = await Tesseract.recognize(filePath, 'eng');
          extractedText = result.data.text;
        }

        // Save results locally
        const resultFileName = `${jobId}.json`;
        const resultPath = path.join(resultsDir, resultFileName);
        
        const resultData = {
          jobId,
          fileName: req.file.originalname,
          pageCount,
          textLength: extractedText.length,
          text: extractedText,
          processedAt: new Date().toISOString(),
          processingTime: Date.now() - jobs.get(jobId).startTime
        };

        fs.writeFileSync(resultPath, JSON.stringify(resultData, null, 2));

        // Upload to backend server
        jobs.set(jobId, { ...jobs.get(jobId), status: 'uploading_to_backend', progress: 90 });
        const backendResponse = await uploadToBackend(resultData, resultFileName);

        // Update job status
        jobs.set(jobId, {
          status: 'completed',
          progress: 100,
          resultFile: resultFileName,
          backendUpload: backendResponse ? 'success' : 'local_only',
          completedAt: new Date().toISOString(),
          processingTime: Date.now() - jobs.get(jobId).startTime
        });

        // Clean up uploaded file
        fs.unlinkSync(filePath);

      } catch (error) {
        console.error(`Error processing job ${jobId}:`, error);
        jobs.set(jobId, {
          status: 'failed',
          error: error.message,
          failedAt: new Date().toISOString()
        });
      }
    })();

    res.json({
      jobId,
      status: 'processing',
      message: 'File uploaded. Processing started.',
      statusUrl: `/api/ocr/${jobId}/status`,
      resultUrl: `/api/ocr/${jobId}/result`
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check job status
app.get('/api/ocr/:jobId/status', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json({
    jobId,
    status: job.status,
    progress: job.progress,
    processingTime: job.processingTime,
    backendUpload: job.backendUpload || null,
    error: job.error || null
  });
});

// Get job result
app.get('/api/ocr/:jobId/result', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status !== 'completed') {
    return res.status(400).json({ error: `Job is ${job.status}` });
  }

  try {
    const resultPath = path.join(resultsDir, job.resultFile);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve result' });
  }
});

// Download result as file
app.get('/api/ocr/:jobId/download', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job || job.status !== 'completed') {
    return res.status(404).json({ error: 'Result not found or not ready' });
  }

  try {
    const resultPath = path.join(resultsDir, job.resultFile);
    res.download(resultPath, `ocr-result-${jobId}.json`);
  } catch (error) {
    res.status(500).json({ error: 'Failed to download result' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`OCR Application running on port ${PORT}`);
  console.log(`Backend server: ${BACKEND_SERVER_URL}`);
});
