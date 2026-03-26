/**
 * ScanLens — Zeabur OCR Backend
 * ─────────────────────────────
 * Deploy this to Zeabur as a Node.js service.
 * Receives PDF uploads, runs Tesseract OCR server-side,
 * and returns searchable PDFs.
 *
 * Required packages (package.json already set below):
 *   express, multer, cors, uuid, tesseract.js, pdf-lib, pdf2pic, sharp
 *
 * Environment variables:
 *   API_KEY      — optional shared secret (set in Zeabur env vars)
 *   PORT         — auto-set by Zeabur (defaults to 3000)
 *   MAX_FILE_MB  — max upload size in MB (default: 100)
 */

'use strict';

const express    = require('express');
const multer     = require('multer');
const cors       = require('cors');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const { PDFDocument } = require('pdf-lib');
const Tesseract  = require('tesseract.js');
const { fromBuffer } = require('pdf2pic');

// ──────────────────────────────────────────────
// App setup
// ──────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '100');
const API_KEY = process.env.API_KEY || '';       // blank = no auth

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

// ──────────────────────────────────────────────
// In-memory job store
// ──────────────────────────────────────────────
const jobs = new Map();
// job shape: { id, status, progress, message, completedPages, totalPages, eta, error, resultPath, startTime, totalTime, avgConfidence }

// Clean up jobs older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (job.createdAt < cutoff) {
      if (job.resultPath) fs.unlink(job.resultPath, () => {});
      if (job.uploadPath) fs.unlink(job.uploadPath, () => {});
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

// ──────────────────────────────────────────────
// Multer storage — write to /tmp
// ──────────────────────────────────────────────
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are accepted'));
    }
  }
});

// ──────────────────────────────────────────────
// Auth middleware
// ──────────────────────────────────────────────
function authCheck(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key === API_KEY) return next();
  res.status(401).json({ error: 'Invalid or missing API key' });
}

// ──────────────────────────────────────────────
// Health check
// ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    jobs: jobs.size,
    uptime: Math.round(process.uptime()),
    maxFileMB: MAX_FILE_MB
  });
});

// ──────────────────────────────────────────────
// POST /api/ocr — accept PDF, start processing
// ──────────────────────────────────────────────
app.post('/api/ocr', authCheck, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });

  let pages, lang, dpi, enhance;
  try {
    pages   = JSON.parse(req.body.pages || 'null');           // array of page numbers
    lang    = req.body.lang    || 'auto';
    dpi     = parseInt(req.body.dpi) || 150;
    enhance = req.body.enhance === 'true';
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request parameters' });
  }

  const jobId = uuidv4();
  const uploadPath = req.file.path;

  const job = {
    id: jobId,
    status: 'queued',
    progress: 0,
    message: 'Queued for processing',
    completedPages: 0,
    totalPages: pages ? pages.length : 0,
    eta: null,
    error: null,
    resultPath: null,
    uploadPath,
    startTime: Date.now(),
    totalTime: null,
    avgConfidence: null,
    createdAt: Date.now(),
    cancelRequested: false
  };

  jobs.set(jobId, job);

  // Respond immediately with job ID so the client can start polling
  res.status(202).json({ jobId, message: 'Job accepted' });

  // Run OCR asynchronously
  processOCR(job, uploadPath, { pages, lang, dpi, enhance }).catch(err => {
    job.status = 'error';
    job.error = err.message;
    console.error(`[${jobId}] Fatal error:`, err);
  });
});

// ──────────────────────────────────────────────
// GET /api/ocr/:jobId/status
// ──────────────────────────────────────────────
app.get('/api/ocr/:jobId/status', authCheck, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.json({
    jobId:          job.id,
    status:         job.status,
    progress:       job.progress,
    message:        job.message,
    completedPages: job.completedPages,
    totalPages:     job.totalPages,
    eta:            job.eta,
    error:          job.error,
    totalTime:      job.totalTime,
    avgConfidence:  job.avgConfidence
  });
});

// ──────────────────────────────────────────────
// GET /api/ocr/:jobId/result — download PDF
// ──────────────────────────────────────────────
app.get('/api/ocr/:jobId/result', authCheck, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') return res.status(409).json({ error: 'Job not complete yet', status: job.status });
  if (!job.resultPath || !fs.existsSync(job.resultPath)) return res.status(410).json({ error: 'Result file no longer available' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="scanlens_ocr_output.pdf"');
  const stream = fs.createReadStream(job.resultPath);
  stream.pipe(res);
});

// ──────────────────────────────────────────────
// POST /api/ocr/:jobId/cancel
// ──────────────────────────────────────────────
app.post('/api/ocr/:jobId/cancel', authCheck, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.cancelRequested = true;
  res.json({ message: 'Cancellation requested' });
});

// ──────────────────────────────────────────────
// Core OCR processing
// ──────────────────────────────────────────────
async function processOCR(job, pdfPath, { pages, lang, dpi, enhance }) {
  const { createCanvas } = require('canvas');   // optional fallback check
  let worker = null;

  try {
    job.status = 'processing';
    job.message = 'Reading PDF...';

    // 1. Read PDF bytes
    const pdfBytes = fs.readFileSync(pdfPath);

    // 2. Convert PDF pages to images using pdf2pic
    job.message = 'Converting PDF pages to images...';
    job.progress = 5;

    const converter = fromBuffer(pdfBytes, {
      density: dpi,
      saveFilename: 'page',
      savePath: os.tmpdir(),
      format: 'jpeg',
      width: Math.round(dpi * 8.5),    // approx letter-width at given DPI
      height: Math.round(dpi * 11)
    });

    // Determine which pages to OCR
    // pdf2pic is 1-indexed
    let totalPdfPages;
    {
      const tempDoc = await PDFDocument.load(pdfBytes);
      totalPdfPages = tempDoc.getPageCount();
    }

    const targetPages = pages
      ? pages.filter(p => p >= 1 && p <= totalPdfPages)
      : Array.from({ length: totalPdfPages }, (_, i) => i + 1);

    job.totalPages = targetPages.length;
    job.message = `Processing ${targetPages.length} page(s)...`;

    // 3. Detect language if auto
    let ocrLang = lang;
    if (lang === 'auto') {
      job.message = 'Detecting language...';
      job.progress = 8;
      // Quick scan of first page
      const firstPageImgResult = await converter(targetPages[0], { responseType: 'buffer' });
      const detectWorker = await Tesseract.createWorker('eng+chi_tra+chi_sim', 1, { logger: () => {} });
      const detectResult  = await detectWorker.recognize(firstPageImgResult.buffer);
      ocrLang = detectLanguage(detectResult.data.text || '');
      await detectWorker.terminate();
    }

    // 4. Init OCR worker
    job.message = `Loading OCR model: ${ocrLang}`;
    job.progress = 12;
    worker = await Tesseract.createWorker(ocrLang, 1, { logger: () => {} });

    // 5. Process each page
    const mergedPdf = await PDFDocument.create();
    const confidences = [];
    const startTime = Date.now();

    for (let i = 0; i < targetPages.length; i++) {
      if (job.cancelRequested) {
        job.status = 'cancelled';
        job.message = 'Cancelled by user';
        return;
      }

      const pageNum = targetPages[i];
      const pct = Math.round(12 + (i / targetPages.length) * 80);
      job.progress = pct;
      job.message = `OCR page ${pageNum} (${i + 1}/${targetPages.length})`;

      // ETA
      if (i > 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const perPage = elapsed / i;
        job.eta = Math.ceil(perPage * (targetPages.length - i));
      }

      console.log(`[${job.id}] Processing page ${pageNum}...`);

      try {
        // Render page to image buffer
        const imgResult = await converter(pageNum, { responseType: 'buffer' });
        let imgBuffer = imgResult.buffer;

        // Optionally enhance contrast
        if (enhance) {
          const sharp = require('sharp');
          imgBuffer = await sharp(imgBuffer)
            .normalise()
            .linear(1.3, -(128 * 0.3))   // contrast boost similar to canvas version
            .toBuffer();
        }

        // Run OCR
        const result = await worker.recognize(imgBuffer);
        const text       = result.data.text || '';
        const confidence = result.data.confidence || 0;
        confidences.push(confidence);

        console.log(`[${job.id}] Page ${pageNum}: ${text.length} chars, conf ${confidence.toFixed(1)}%`);

        // Get searchable PDF from Tesseract
        let pagePdfBytes = null;
        try {
          const pdfOut = await worker.getPDF('ScanLens OCR');
          pagePdfBytes = new Uint8Array(pdfOut.data);
        } catch (e) {
          console.warn(`[${job.id}] getPDF failed for page ${pageNum}, using image fallback`);
        }

        if (pagePdfBytes) {
          const srcDoc = await PDFDocument.load(pagePdfBytes);
          const [copiedPage] = await mergedPdf.copyPages(srcDoc, [0]);
          mergedPdf.addPage(copiedPage);
        } else {
          // Fallback: embed raw image
          const embeddedImg = await mergedPdf.embedJpg(imgBuffer);
          const dims = embeddedImg.scale(1);
          const imgPage = mergedPdf.addPage([dims.width, dims.height]);
          imgPage.drawImage(embeddedImg, { x: 0, y: 0, width: dims.width, height: dims.height });
        }
      } catch (pageErr) {
        console.error(`[${job.id}] Error on page ${pageNum}:`, pageErr.message);
        // Skip this page rather than failing the whole job
      }

      job.completedPages = i + 1;
    }

    await worker.terminate();
    worker = null;

    // 6. Save merged PDF
    job.message = 'Building final PDF...';
    job.progress = 95;

    const outBytes = await mergedPdf.save();
    const resultPath = path.join(os.tmpdir(), `${job.id}_result.pdf`);
    fs.writeFileSync(resultPath, outBytes);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const avgConf = confidences.length
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : 0;

    job.status         = 'done';
    job.progress       = 100;
    job.message        = 'Complete';
    job.resultPath     = resultPath;
    job.totalTime      = parseFloat(totalTime);
    job.avgConfidence  = avgConf;
    job.eta            = 0;

    console.log(`[${job.id}] Done — ${targetPages.length} pages, ${(outBytes.length / 1024 / 1024).toFixed(1)} MB, ${totalTime}s`);

    // Clean up upload
    fs.unlink(pdfPath, () => {});

  } catch (err) {
    if (worker) { try { await worker.terminate(); } catch(e) {} }
    fs.unlink(pdfPath, () => {});
    throw err;
  }
}

// ──────────────────────────────────────────────
// Language detection helper (mirrors client-side)
// ──────────────────────────────────────────────
function detectLanguage(text) {
  if (!text || text.trim().length < 5) return 'eng';
  let cjkCount = 0, engCount = 0, traIndicators = 0, simIndicators = 0;
  const traChars = '國學數與對這經區體發聯當會從點問機關個義處應實來將過還後給讓說時種為開黨對質開裡類';
  const simChars = '国学数与对这经区体发联当会从点问机关个义处应实来将过还后给让说时种为开党对质开里类';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0x4E00 && code <= 0x9FFF) {
      cjkCount++;
      if (traChars.includes(ch)) traIndicators++;
      if (simChars.includes(ch)) simIndicators++;
    } else if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) {
      engCount++;
    }
  }
  const total = cjkCount + engCount;
  if (total === 0) return 'eng';
  if (cjkCount / total > 0.3) {
    if (traIndicators > simIndicators) return 'chi_tra';
    if (simIndicators > traIndicators) return 'chi_sim';
    return 'chi_tra+chi_sim';
  }
  return 'eng';
}

// ──────────────────────────────────────────────
// Error handler
// ──────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.message);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File too large — max ${MAX_FILE_MB} MB` });
  }
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ──────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ScanLens OCR server running on port ${PORT}`);
  console.log(`Auth: ${API_KEY ? 'enabled (X-API-Key header)' : 'disabled'}`);
  console.log(`Max upload: ${MAX_FILE_MB} MB`);
});
