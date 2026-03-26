/**
 * ScanLens — Zeabur OCR Backend  v1.1.0
 * ──────────────────────────────────────
 * Each page is saved to disk immediately after OCR completes.
 * Only after ALL pages finish are they merged into the final PDF.
 * This prevents memory build-up on long jobs and means a crash
 * only loses the page currently being processed, not prior work.
 *
 * Environment variables:
 *   API_KEY      — optional shared secret  (set in Zeabur env vars)
 *   PORT         — auto-set by Zeabur      (default 3000)
 *   MAX_FILE_MB  — max upload size in MB   (default 100)
 */

'use strict';

const express         = require('express');
const multer          = require('multer');
const cors            = require('cors');
const { v4: uuidv4 } = require('uuid');
const path            = require('path');
const fs              = require('fs');
const os              = require('os');
const { PDFDocument } = require('pdf-lib');
const Tesseract       = require('tesseract.js');
const { fromBuffer }  = require('pdf2pic');

// ─────────────────────────────────────────────────────────
// App setup
// ─────────────────────────────────────────────────────────
const app         = express();
const PORT        = process.env.PORT        || 3000;
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '100');
const API_KEY     = process.env.API_KEY     || '';   // blank = no auth

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] }));
app.use(express.json());

// ─────────────────────────────────────────────────────────
// In-memory job store
// ─────────────────────────────────────────────────────────
/**
 * Job shape:
 * {
 *   id, status, progress, message,
 *   completedPages, totalPages, eta,
 *   error, resultPath, uploadPath,
 *   pageFiles,          <- array of { pageNum, filePath } written so far
 *   startTime, totalTime, avgConfidence,
 *   createdAt, cancelRequested
 * }
 */
const jobs = new Map();

// Clean up jobs and their temp files older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (job.createdAt < cutoff) {
      cleanupJob(job);
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

function cleanupJob(job) {
  if (job.resultPath) safeUnlink(job.resultPath);
  if (job.uploadPath) safeUnlink(job.uploadPath);
  if (Array.isArray(job.pageFiles)) {
    for (const { filePath } of job.pageFiles) safeUnlink(filePath);
  }
}

function safeUnlink(filePath) {
  try { fs.unlinkSync(filePath); } catch (_) {}
}

// ─────────────────────────────────────────────────────────
// Multer — write uploads to /tmp
// ─────────────────────────────────────────────────────────
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are accepted'));
    }
  }
});

// ─────────────────────────────────────────────────────────
// Auth middleware
// ─────────────────────────────────────────────────────────
function authCheck(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key === API_KEY) return next();
  res.status(401).json({ error: 'Invalid or missing API key' });
}

// ─────────────────────────────────────────────────────────
// GET /api/health
// ─────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status:    'ok',
    version:   '1.1.0',
    jobs:      jobs.size,
    uptime:    Math.round(process.uptime()),
    maxFileMB: MAX_FILE_MB
  });
});

// ─────────────────────────────────────────────────────────
// POST /api/ocr — accept PDF, queue job, return immediately
// ─────────────────────────────────────────────────────────
app.post('/api/ocr', authCheck, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });

  let pages, lang, dpi, enhance;
  try {
    pages   = JSON.parse(req.body.pages  || 'null');
    lang    = req.body.lang              || 'auto';
    dpi     = parseInt(req.body.dpi)     || 150;
    enhance = req.body.enhance           === 'true';
  } catch (_) {
    return res.status(400).json({ error: 'Invalid request parameters' });
  }

  const jobId      = uuidv4();
  const uploadPath = req.file.path;

  const job = {
    id:              jobId,
    status:          'queued',
    progress:        0,
    message:         'Queued for processing',
    completedPages:  0,
    totalPages:      pages ? pages.length : 0,
    eta:             null,
    error:           null,
    resultPath:      null,
    uploadPath,
    pageFiles:       [],   // populated as each page finishes
    startTime:       Date.now(),
    totalTime:       null,
    avgConfidence:   null,
    createdAt:       Date.now(),
    cancelRequested: false
  };

  jobs.set(jobId, job);

  // Respond immediately — client starts polling
  res.status(202).json({ jobId, message: 'Job accepted' });

  // Run OCR in background
  processOCR(job, uploadPath, { pages, lang, dpi, enhance }).catch(err => {
    job.status = 'error';
    job.error  = err.message;
    console.error(`[${jobId}] Fatal error:`, err);
  });
});

// ─────────────────────────────────────────────────────────
// GET /api/ocr/:jobId/status
// ─────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────
// GET /api/ocr/:jobId/result — stream final PDF to client
// ─────────────────────────────────────────────────────────
app.get('/api/ocr/:jobId/result', authCheck, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job)
    return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done')
    return res.status(409).json({ error: 'Job not complete yet', status: job.status });
  if (!job.resultPath || !fs.existsSync(job.resultPath))
    return res.status(410).json({ error: 'Result file no longer available' });

  res.setHeader('Content-Type',        'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="scanlens_ocr_output.pdf"');
  fs.createReadStream(job.resultPath).pipe(res);
});

// ─────────────────────────────────────────────────────────
// GET /api/jobs — list all jobs for the file manager
// ─────────────────────────────────────────────────────────
app.get('/api/jobs', authCheck, (_req, res) => {
  const list = [];
  for (const job of jobs.values()) {
    let fileSizeBytes = 0;
    if (job.resultPath) {
      try { fileSizeBytes = fs.statSync(job.resultPath).size; } catch (_) {}
    }
    list.push({
      jobId:          job.id,
      status:         job.status,
      totalPages:     job.totalPages,
      completedPages: job.completedPages,
      totalTime:      job.totalTime,
      avgConfidence:  job.avgConfidence,
      createdAt:      job.createdAt,
      fileSizeBytes,
      hasResult:      !!(job.resultPath && fs.existsSync(job.resultPath)),
      error:          job.error || null
    });
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ jobs: list });
});

// ─────────────────────────────────────────────────────────
// DELETE /api/ocr/:jobId — remove job record + all its files
// ─────────────────────────────────────────────────────────
app.delete('/api/ocr/:jobId', authCheck, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.cancelRequested = true;   // stop it if still running
  cleanupJob(job);
  jobs.delete(req.params.jobId);
  res.json({ message: 'Job deleted' });
});

// ─────────────────────────────────────────────────────────
// POST /api/ocr/:jobId/cancel
// ─────────────────────────────────────────────────────────
app.post('/api/ocr/:jobId/cancel', authCheck, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.cancelRequested = true;
  res.json({ message: 'Cancellation requested' });
});

// ─────────────────────────────────────────────────────────
// Core OCR pipeline
// ─────────────────────────────────────────────────────────
async function processOCR(job, pdfPath, { pages, lang, dpi, enhance }) {
  let worker = null;

  try {
    job.status  = 'processing';
    job.message = 'Reading PDF...';

    // 1. Read the uploaded PDF
    const pdfBytes = fs.readFileSync(pdfPath);

    // 2. Build page-to-image converter
    job.message  = 'Preparing page renderer...';
    job.progress = 5;

    const converter = fromBuffer(pdfBytes, {
      density:      dpi,
      saveFilename: 'page',
      savePath:     os.tmpdir(),
      format:       'jpeg',
      width:        Math.round(dpi * 8.5),
      height:       Math.round(dpi * 11)
    });

    // Resolve the true page count and validate requested pages
    const tempDoc       = await PDFDocument.load(pdfBytes);
    const totalPdfPages = tempDoc.getPageCount();

    const targetPages = pages
      ? pages.filter(p => p >= 1 && p <= totalPdfPages)
      : Array.from({ length: totalPdfPages }, (_, i) => i + 1);

    job.totalPages = targetPages.length;
    job.message    = `Processing ${targetPages.length} page(s)...`;

    // 3. Language detection (if auto)
    let ocrLang = lang;
    if (lang === 'auto') {
      job.message  = 'Detecting language...';
      job.progress = 8;

      const firstImg     = await converter(targetPages[0], { responseType: 'buffer' });
      const detectWorker = await Tesseract.createWorker('eng+chi_tra+chi_sim', 1, { logger: () => {} });
      const detectResult = await detectWorker.recognize(firstImg.buffer);
      ocrLang            = detectLanguage(detectResult.data.text || '');
      await detectWorker.terminate();

      console.log(`[${job.id}] Detected language: ${ocrLang}`);
    }

    // 4. Start main OCR worker
    job.message  = `Loading OCR model: ${ocrLang}`;
    job.progress = 12;
    worker = await Tesseract.createWorker(ocrLang, 1, { logger: () => {} });
    console.log(`[${job.id}] OCR worker ready (${ocrLang})`);

    // 5. Process pages one by one — save each to disk immediately after OCR
    const confidences = [];
    const startTime   = Date.now();

    for (let i = 0; i < targetPages.length; i++) {

      // Honour cancel between pages
      if (job.cancelRequested) {
        job.status  = 'cancelled';
        job.message = 'Cancelled by user';
        return;
      }

      const pageNum    = targetPages[i];
      job.progress     = Math.round(12 + (i / targetPages.length) * 80);
      job.message      = `OCR page ${pageNum} (${i + 1}/${targetPages.length})`;

      // Running ETA
      if (i > 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        job.eta = Math.ceil((elapsed / i) * (targetPages.length - i));
      }

      console.log(`[${job.id}] Processing page ${pageNum}...`);

      // Destination for this page's PDF — zero-padded so glob/sort works naturally
      const pageFilePath = path.join(
        os.tmpdir(),
        `${job.id}_page_${String(pageNum).padStart(5, '0')}.pdf`
      );

      try {
        // 5a. Render page → JPEG buffer
        const imgResult = await converter(pageNum, { responseType: 'buffer' });
        let imgBuffer   = imgResult.buffer;

        // 5b. Optional contrast enhancement
        if (enhance) {
          const sharp = require('sharp');
          imgBuffer   = await sharp(imgBuffer)
            .normalise()
            .linear(1.3, -(128 * 0.3))
            .toBuffer();
        }

        // 5c. Run OCR
        const result     = await worker.recognize(imgBuffer);
        const text       = result.data.text       || '';
        const confidence = result.data.confidence || 0;
        confidences.push(confidence);
        console.log(`[${job.id}] Page ${pageNum}: ${text.length} chars, conf ${confidence.toFixed(1)}%`);

        // 5d. Get single-page searchable PDF from Tesseract and save to disk
        let savedToFile = false;
        try {
          const pdfOut       = await worker.getPDF('ScanLens OCR');
          const pagePdfBytes = new Uint8Array(pdfOut.data);

          // ★ Write this page to disk immediately — no more in-memory accumulation ★
          fs.writeFileSync(pageFilePath, pagePdfBytes);
          savedToFile = true;
          console.log(`[${job.id}] Page ${pageNum} written → ${path.basename(pageFilePath)}`);
        } catch (getPdfErr) {
          console.warn(`[${job.id}] getPDF failed for page ${pageNum}: ${getPdfErr.message}`);
        }

        // 5e. Fallback: build a plain image-only PDF page and save that instead
        if (!savedToFile) {
          const fallbackDoc = await PDFDocument.create();
          const embedded    = await fallbackDoc.embedJpg(imgBuffer);
          const dims        = embedded.scale(1);
          const imgPage     = fallbackDoc.addPage([dims.width, dims.height]);
          imgPage.drawImage(embedded, { x: 0, y: 0, width: dims.width, height: dims.height });
          const fallbackBytes = await fallbackDoc.save();

          // ★ Fallback page also written to disk immediately ★
          fs.writeFileSync(pageFilePath, fallbackBytes);
          console.log(`[${job.id}] Page ${pageNum} written (image fallback) → ${path.basename(pageFilePath)}`);
        }

        // Register the saved file so merge and cleanup can find it
        job.pageFiles.push({ pageNum, filePath: pageFilePath });

      } catch (pageErr) {
        // A single bad page must not abort the whole job
        console.error(`[${job.id}] Error on page ${pageNum}:`, pageErr.message);
      }

      job.completedPages = i + 1;
    } // ── end of page loop ────────────────────────────────

    // 6. Terminate OCR worker — all pages are done
    await worker.terminate();
    worker = null;

    if (job.pageFiles.length === 0) {
      throw new Error('No pages were successfully processed');
    }

    // 7. Merge all saved per-page PDFs into the final document
    job.message  = `Merging ${job.pageFiles.length} saved page(s) into final PDF...`;
    job.progress = 95;
    console.log(`[${job.id}] Merging ${job.pageFiles.length} page file(s)...`);

    const mergedPdf = await PDFDocument.create();

    // Sort by original page number before merging (preserves order)
    const sorted = [...job.pageFiles].sort((a, b) => a.pageNum - b.pageNum);

    for (const { pageNum, filePath } of sorted) {
      try {
        const pageBytes = fs.readFileSync(filePath);
        const srcDoc    = await PDFDocument.load(pageBytes);
        const [copied]  = await mergedPdf.copyPages(srcDoc, [0]);
        mergedPdf.addPage(copied);
      } catch (mergeErr) {
        // Log and skip; one broken page file shouldn't destroy the whole output
        console.error(`[${job.id}] Merge error for page ${pageNum}:`, mergeErr.message);
      }
    }

    // 8. Persist the merged PDF
    job.message  = 'Writing final PDF...';
    job.progress = 98;

    const outBytes   = await mergedPdf.save();
    const resultPath = path.join(os.tmpdir(), `${job.id}_result.pdf`);
    fs.writeFileSync(resultPath, outBytes);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const avgConf   = confidences.length
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : 0;

    job.status        = 'done';
    job.progress      = 100;
    job.message       = 'Complete';
    job.resultPath    = resultPath;
    job.totalTime     = parseFloat(totalTime);
    job.avgConfidence = avgConf;
    job.eta           = 0;

    console.log(
      `[${job.id}] Done — ${job.pageFiles.length} pages merged, ` +
      `${(outBytes.length / 1024 / 1024).toFixed(1)} MB, ${totalTime}s`
    );

    // 9. Clean up per-page temp files and the original upload
    for (const { filePath } of job.pageFiles) safeUnlink(filePath);
    job.pageFiles = [];   // cleared — files are gone
    safeUnlink(pdfPath);

  } catch (err) {
    if (worker) { try { await worker.terminate(); } catch (_) {} }
    safeUnlink(pdfPath);
    // Per-page files are left for diagnostics; the 30-min GC will handle them
    throw err;
  }
}

// ─────────────────────────────────────────────────────────
// Language detection  (mirrors client-side logic)
// ─────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────
// Global error handler
// ─────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err.message);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File too large — max ${MAX_FILE_MB} MB` });
  }
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ScanLens OCR server v1.1.0 running on port ${PORT}`);
  console.log(`Auth: ${API_KEY ? 'enabled (X-API-Key)' : 'disabled'}`);
  console.log(`Max upload: ${MAX_FILE_MB} MB`);
});
