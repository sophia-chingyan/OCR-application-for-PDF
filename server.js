const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const upload = multer({ storage: multer.memoryStorage() });
const jobs = new Map();

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// Upload and start OCR job
app.post('/api/ocr', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const jobId = uuidv4();
    const pages = JSON.parse(req.body.pages || '[]');
    const lang = req.body.lang || 'eng';
    const dpi = parseInt(req.body.dpi) || 150;
    const enhance = req.body.enhance === 'true';

    jobs.set(jobId, {
      status: 'processing',
      progress: 0,
      message: 'Starting OCR...',
      completedPages: 0,
      totalPages: pages.length,
      result: null,
      error: null,
      startTime: Date.now()
    });

    // Start async processing
    processOCR(jobId, req.file.buffer, pages, lang, dpi, enhance);

    res.json({ jobId, message: 'OCR job started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check job status
app.get('/api/ocr/:jobId/status', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  
  const elapsed = Math.round((Date.now() - job.startTime) / 1000);
  res.json({
    status: job.status,
    progress: job.progress,
    message: job.message,
    completedPages: job.completedPages,
    totalPages: job.totalPages,
    eta: job.status === 'processing' ? Math.max(0, Math.round(elapsed * (job.totalPages - job.completedPages) / Math.max(1, job.completedPages))) : null,
    totalTime: job.status === 'done' ? elapsed : null,
    avgConfidence: job.avgConfidence || null
  });
});

// Download result
app.get('/api/ocr/:jobId/result', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') return res.status(400).json({ error: 'Job not complete' });
  if (!job.result) return res.status(500).json({ error: 'No result available' });
  
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="result.pdf"');
  res.send(job.result);
});

// Cancel job
app.post('/api/ocr/:jobId/cancel', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.status = 'cancelled';
  res.json({ message: 'Cancellation requested' });
});

// Serve static files
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ScanLens OCR server running on http://0.0.0.0:${PORT}`);
});

// Placeholder OCR processing (you'll need to implement actual OCR)
async function processOCR(jobId, fileBuffer, pages, lang, dpi, enhance) {
  const job = jobs.get(jobId);
  try {
    // TODO: Implement actual OCR processing with tesseract.js or similar
    // For now, just mark as done
    job.status = 'done';
    job.progress = 100;
    job.message = 'OCR complete';
    job.completedPages = pages.length;
    job.result = fileBuffer; // In real implementation, return processed PDF
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
  }
}
