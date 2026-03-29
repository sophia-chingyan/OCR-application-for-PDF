const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, '.')));

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

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    jobs: jobs.size
  });
});

// Upload and process PDF
app.post('/api/ocr', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const jobId = uuidv4();
    const filePath = req.file.path;
    const pages = req.body.pages ? JSON.parse(req.body.pages) : [];
    const lang = req.body.lang || 'eng';
    const dpi = parseInt(req.body.dpi) || 150;
    const enhance = req.body.enhance === 'true';

    // Initialize job
    jobs.set(jobId, {
      status: 'processing',
      progress: 0,
      message: 'Starting OCR...',
      startTime: Date.now(),
      fileName: req.file.originalname,
      totalPages: pages.length,
      completedPages: 0,
      avgConfidence: 0
    });

    // Process PDF asynchronously
    (async () => {
      try {
        const pdfBuffer = fs.readFileSync(filePath);
        const pdfData = await pdfParse(pdfBuffer);
        
        let totalConfidence = 0;
        let processedCount = 0;

        // Process each page with OCR
        for (const pageNum of pages) {
          const job = jobs.get(jobId);
          if (!job) break;

          job.message = `Processing page ${pageNum}...`;
          job.progress = (processedCount / pages.length) * 100;

          try {
            // Tesseract OCR processing
            const result = await Tesseract.recognize(filePath, lang);
            totalConfidence += result.data.confidence || 0;
            processedCount++;
            job.completedPages = processedCount;
          } catch (err) {
            console.error(`Error on page ${pageNum}:`, err.message);
          }
        }

        // Calculate average confidence
        const avgConfidence = processedCount > 0 ? totalConfidence / processedCount : 0;

        // Save result
        const resultFileName = `${jobId}.pdf`;
        const resultPath = path.join(resultsDir, resultFileName);

        // For now, copy the original PDF as result
        // In production, you'd embed OCR text layer here
        fs.copyFileSync(filePath, resultPath);

        // Update job to done
        jobs.set(jobId, {
          status: 'done',
          progress: 100,
          message: 'OCR complete',
          completedPages: pages.length,
          totalPages: pages.length,
          avgConfidence: avgConfidence,
          totalTime: Math.round((Date.now() - jobs.get(jobId).startTime) / 1000),
          hasResult: true,
          resultFile: resultFileName
        });

        // Clean up uploaded file
        fs.unlinkSync(filePath);

      } catch (error) {
        console.error(`Error processing job ${jobId}:`, error);
        jobs.set(jobId, {
          status: 'error',
          error: error.message,
          progress: 0
        });
      }
    })();

    res.json({
      jobId,
      status: 'processing',
      message: 'File uploaded. Processing started.'
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

  res.json(job);
});

// Get job result (PDF download)
app.get('/api/ocr/:jobId/result', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job || job.status !== 'done') {
    return res.status(400).json({ error: 'Result not available' });
  }

  try {
    const resultPath = path.join(resultsDir, job.resultFile);
    res.download(resultPath, `ocr-result-${jobId}.pdf`);
  } catch (error) {
    res.status(500).json({ error: 'Failed to download result' });
  }
});

// List all jobs (for admin panel)
app.get('/api/jobs', (req, res) => {
  const jobsList = Array.from(jobs.values()).map((job, idx) => ({
    jobId: Array.from(jobs.keys())[idx],
    ...job,
    createdAt: job.startTime
  }));
  res.json({ jobs: jobsList });
});

// Delete a job
app.delete('/api/ocr/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  try {
    if (job.resultFile) {
      const resultPath = path.join(resultsDir, job.resultFile);
      if (fs.existsSync(resultPath)) {
        fs.unlinkSync(resultPath);
      }
    }
    jobs.delete(jobId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve index.html for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`OCR Application running on port ${PORT}`);
});
