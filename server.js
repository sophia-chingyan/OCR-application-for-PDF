/**
 * ScanLens — Zeabur OCR Backend  v1.2.0
 * ──────────────────────────────────────
 * Supports: English, Traditional Chinese (H+V), Simplified Chinese (H+V),
 *           Japanese (H+V), Korean.
 *
 * Each page is saved to disk immediately after OCR completes.
 * Only after ALL pages finish are they merged into the final PDF.
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
const API_KEY     = process.env.API_KEY     || '';

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] }));
app.use(express.json());

// ─────────────────────────────────────────────────────────
// Language label map (FIX: comprehensive, all supported languages)
// ─────────────────────────────────────────────────────────
const LANG_LABELS = {
  'eng':                    'English',
  'chi_tra':                'Traditional Chinese (Horizontal)',
  'chi_tra_vert':           'Traditional Chinese (Vertical)',
  'chi_sim':                'Simplified Chinese (Horizontal)',
  'chi_sim_vert':           'Simplified Chinese (Vertical)',
  'chi_tra+chi_sim':        'Chinese Mixed',
  'chi_tra_vert+chi_sim_vert': 'Chinese Vertical Mixed',
  'jpn':                    'Japanese (Horizontal)',
  'jpn_vert':               'Japanese (Vertical)',
  'kor':                    'Korean',
  'chi_tra+chi_sim+eng':    'Chinese + English',
  'jpn+kor+eng':            'Japanese + Korean + English',
  'chi_tra+chi_tra_vert+chi_sim+chi_sim_vert+jpn+jpn_vert+kor+eng': 'All Languages'
};

function getLangLabel(lang) {
  return LANG_LABELS[lang] || lang;
}

// Vertical model mapping for CJK/Japanese auto-detect
const VERT_MAP = {
  'chi_tra':        'chi_tra_vert',
  'chi_sim':        'chi_sim_vert',
  'jpn':            'jpn_vert',
  'chi_tra+chi_sim': 'chi_tra_vert+chi_sim_vert'
};

// ─────────────────────────────────────────────────────────
// In-memory job store
// ─────────────────────────────────────────────────────────
const jobs = new Map();

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (job.createdAt < cutoff) { cleanupJob(job); jobs.delete(id); }
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
// Multer
// ─────────────────────────────────────────────────────────
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.endsWith('.pdf')) cb(null, true);
    else cb(new Error('Only PDF files are accepted'));
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
    version:   '1.2.0',
    jobs:      jobs.size,
    uptime:    Math.round(process.uptime()),
    maxFileMB: MAX_FILE_MB,
    // FIX: advertise all supported languages
    supportedLanguages: Object.keys(LANG_LABELS)
  });
});

// ─────────────────────────────────────────────────────────
// POST /api/ocr
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
    pageFiles:       [],
    startTime:       Date.now(),
    totalTime:       null,
    avgConfidence:   null,
    detectedLang:    null,
    createdAt:       Date.now(),
    cancelRequested: false
  };

  jobs.set(jobId, job);
  res.status(202).json({ jobId, message: 'Job accepted' });

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
    avgConfidence:  job.avgConfidence,
    detectedLang:   job.detectedLang
  });
});

// ─────────────────────────────────────────────────────────
// GET /api/ocr/:jobId/result
// ─────────────────────────────────────────────────────────
app.get('/api/ocr/:jobId/result', authCheck, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') return res.status(409).json({ error: 'Job not complete yet', status: job.status });
  if (!job.resultPath || !fs.existsSync(job.resultPath)) return res.status(410).json({ error: 'Result file no longer available' });
  res.setHeader('Content-Type',        'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="scanlens_ocr_output.pdf"');
  fs.createReadStream(job.resultPath).pipe(res);
});

// ─────────────────────────────────────────────────────────
// GET /api/jobs
// ─────────────────────────────────────────────────────────
app.get('/api/jobs', authCheck, (_req, res) => {
  const list = [];
  for (const job of jobs.values()) {
    let fileSizeBytes = 0;
    if (job.resultPath) { try { fileSizeBytes = fs.statSync(job.resultPath).size; } catch (_) {} }
    list.push({
      jobId:          job.id,
      status:         job.status,
      totalPages:     job.totalPages,
      completedPages: job.completedPages,
      totalTime:      job.totalTime,
      avgConfidence:  job.avgConfidence,
      detectedLang:   job.detectedLang,
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
// DELETE /api/ocr/:jobId
// ─────────────────────────────────────────────────────────
app.delete('/api/ocr/:jobId', authCheck, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.cancelRequested = true;
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
// Language detection
// FIX: Completely rewritten — now detects Korean, Japanese, and both Chinese scripts
// ─────────────────────────────────────────────────────────
function detectLanguage(text) {
  if (!text || text.trim().length < 5) return 'eng';

  let cjkCount      = 0;  // CJK Unified Ideographs (Chinese & Japanese kanji)
  let engCount      = 0;  // Latin alphabet
  let hangulCount   = 0;  // Korean Hangul
  let hiraganaCount = 0;  // Hiragana — exclusive to Japanese
  let katakanaCount = 0;  // Katakana — exclusive to Japanese
  let traIndicators = 0;  // Traditional Chinese character hits
  let simIndicators = 0;  // Simplified Chinese character hits

  // Character discrimination lists for Traditional vs Simplified
  const traChars = '國學數與對這經區體發聯當會從點問機關個義處應實來將過還後給讓說時種為開黨質裡類書閱讀寫語陽陰電龍鳳鷹號';
  const simChars  = '国学数与对这经区体发联当会从点问机关个义处应实来将过还后给让说时种为开党质里类书阅读写语阳阴电龙凤鹰号';

  for (const ch of text) {
    const code = ch.charCodeAt(0);

    // CJK Unified Ideographs (U+4E00–U+9FFF) + CJK Extension A (U+3400–U+4DBF)
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) {
      cjkCount++;
      if (traChars.includes(ch)) traIndicators++;
      if (simChars.includes(ch))  simIndicators++;
    }
    // Hangul Syllables (U+AC00–U+D7A3)
    else if (code >= 0xAC00 && code <= 0xD7A3) { hangulCount++; }
    // Hangul Jamo (U+1100–U+11FF) and Compatibility Jamo (U+3130–U+318F)
    else if ((code >= 0x1100 && code <= 0x11FF) || (code >= 0x3130 && code <= 0x318F)) { hangulCount++; }
    // Hangul Extended (U+A960–U+A97F, U+D7B0–U+D7FF)
    else if ((code >= 0xA960 && code <= 0xA97F) || (code >= 0xD7B0 && code <= 0xD7FF)) { hangulCount++; }
    // Hiragana (U+3040–U+309F) — unique to Japanese
    else if (code >= 0x3040 && code <= 0x309F) { hiraganaCount++; }
    // Katakana (U+30A0–U+30FF) — unique to Japanese
    else if (code >= 0x30A0 && code <= 0x30FF) { katakanaCount++; }
    // Latin
    else if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) { engCount++; }
  }

  const japaneseKanaCount = hiraganaCount + katakanaCount;
  const total = cjkCount + engCount + hangulCount + japaneseKanaCount;
  if (total === 0) return 'eng';

  // Korean: significant Hangul presence
  if (hangulCount / total > 0.15) return 'kor';

  // Japanese: Hiragana/Katakana never appear in Chinese text
  if (japaneseKanaCount > 0 && japaneseKanaCount / total > 0.05) return 'jpn';

  // Chinese (pure CJK without kana markers)
  if (cjkCount / total > 0.25) {
    if (traIndicators > simIndicators * 1.2) return 'chi_tra';
    if (simIndicators > traIndicators * 1.2) return 'chi_sim';
    return 'chi_tra+chi_sim';
  }

  return 'eng';
}

// ─────────────────────────────────────────────────────────
// Core OCR pipeline
// ─────────────────────────────────────────────────────────
async function processOCR(job, pdfPath, { pages, lang, dpi, enhance }) {
  let worker = null;

  try {
    job.status  = 'processing';
    job.message = 'Reading PDF...';

    const pdfBytes = fs.readFileSync(pdfPath);

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

    const tempDoc       = await PDFDocument.load(pdfBytes);
    const totalPdfPages = tempDoc.getPageCount();

    const targetPages = pages
      ? pages.filter(p => p >= 1 && p <= totalPdfPages)
      : Array.from({ length: totalPdfPages }, (_, i) => i + 1);

    job.totalPages = targetPages.length;
    job.message    = `Processing ${targetPages.length} page(s)...`;

    // ── Language + orientation detection ────────────────────────────────────
    let ocrLang = lang;

    if (lang === 'auto') {
      job.message  = 'Detecting language and orientation...';
      job.progress = 8;

      // FIX: Use comprehensive language set including jpn and kor for detection
      const firstImg     = await converter(targetPages[0], { responseType: 'buffer' });
      const detectWorker = await Tesseract.createWorker('eng+chi_tra+chi_sim+jpn+kor', 1, { logger: () => {} });
      const detectResult = await detectWorker.recognize(firstImg.buffer);
      const detectedText = detectResult.data.text       || '';
      const baseConf     = detectResult.data.confidence || 0;
      await detectWorker.terminate();

      const baseLang = detectLanguage(detectedText);
      console.log(`[${job.id}] Language detection: ${getLangLabel(baseLang)}, confidence ${baseConf.toFixed(1)}%`);

      // FIX: Vertical orientation check for CJK / Japanese when confidence is low
      if (VERT_MAP[baseLang] && baseConf < 45) {
        console.log(`[${job.id}] Low confidence (${baseConf.toFixed(1)}%) — testing vertical orientation...`);
        const vertLang   = VERT_MAP[baseLang];
        const vertWorker = await Tesseract.createWorker(vertLang, 1, { logger: () => {} });
        const vertResult = await vertWorker.recognize(firstImg.buffer);
        const vertConf   = vertResult.data.confidence || 0;
        await vertWorker.terminate();

        console.log(`[${job.id}] Vertical confidence: ${vertConf.toFixed(1)}% vs horizontal: ${baseConf.toFixed(1)}%`);
        if (vertConf > baseConf + 8) {
          ocrLang = vertLang;
          console.log(`[${job.id}] Vertical writing detected — using ${getLangLabel(vertLang)}`);
        } else {
          ocrLang = baseLang;
          console.log(`[${job.id}] Horizontal writing confirmed — using ${getLangLabel(baseLang)}`);
        }
      } else {
        ocrLang = baseLang;
      }
    }

    job.detectedLang = ocrLang;
    job.message      = `Loading OCR model: ${getLangLabel(ocrLang)}`;
    job.progress     = 12;

    worker = await Tesseract.createWorker(ocrLang, 1, { logger: () => {} });
    console.log(`[${job.id}] OCR worker ready (${ocrLang})`);

    // ── Process pages one-by-one ─────────────────────────────────────────────
    const confidences = [];
    const startTime   = Date.now();

    for (let i = 0; i < targetPages.length; i++) {
      if (job.cancelRequested) { job.status = 'cancelled'; job.message = 'Cancelled by user'; return; }

      const pageNum    = targetPages[i];
      job.progress     = Math.round(12 + (i / targetPages.length) * 80);
      job.message      = `OCR page ${pageNum} (${i + 1}/${targetPages.length})`;

      if (i > 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        job.eta = Math.ceil((elapsed / i) * (targetPages.length - i));
      }

      console.log(`[${job.id}] Processing page ${pageNum}...`);

      const pageFilePath = path.join(
        os.tmpdir(),
        `${job.id}_page_${String(pageNum).padStart(5, '0')}.pdf`
      );

      try {
        const imgResult = await converter(pageNum, { responseType: 'buffer' });
        let imgBuffer   = imgResult.buffer;

        if (enhance) {
          const sharp = require('sharp');
          imgBuffer   = await sharp(imgBuffer).normalise().linear(1.3, -(128 * 0.3)).toBuffer();
        }

        const result     = await worker.recognize(imgBuffer);
        const text       = result.data.text       || '';
        const confidence = result.data.confidence || 0;
        confidences.push(confidence);

        // FIX: Use getLangLabel() for consistent logging
        console.log(`[${job.id}] Page ${pageNum}: ${text.length} chars, conf ${confidence.toFixed(1)}%, lang: ${getLangLabel(ocrLang)}`);

        let savedToFile = false;
        try {
          const pdfOut       = await worker.getPDF('ScanLens OCR');
          const pagePdfBytes = new Uint8Array(pdfOut.data);
          fs.writeFileSync(pageFilePath, pagePdfBytes);
          savedToFile = true;
          console.log(`[${job.id}] Page ${pageNum} written → ${path.basename(pageFilePath)}`);
        } catch (getPdfErr) {
          console.warn(`[${job.id}] getPDF failed for page ${pageNum}: ${getPdfErr.message}`);
        }

        if (!savedToFile) {
          const fallbackDoc = await PDFDocument.create();
          const embedded    = await fallbackDoc.embedJpg(imgBuffer);
          const dims        = embedded.scale(1);
          const imgPage     = fallbackDoc.addPage([dims.width, dims.height]);
          imgPage.drawImage(embedded, { x: 0, y: 0, width: dims.width, height: dims.height });
          const fallbackBytes = await fallbackDoc.save();
          fs.writeFileSync(pageFilePath, fallbackBytes);
          console.log(`[${job.id}] Page ${pageNum} written (image fallback) → ${path.basename(pageFilePath)}`);
        }

        job.pageFiles.push({ pageNum, filePath: pageFilePath });

      } catch (pageErr) {
        console.error(`[${job.id}] Error on page ${pageNum}:`, pageErr.message);
      }

      job.completedPages = i + 1;
    }

    await worker.terminate();
    worker = null;

    if (job.pageFiles.length === 0) throw new Error('No pages were successfully processed');

    // ── Merge all per-page PDFs ──────────────────────────────────────────────
    job.message  = `Merging ${job.pageFiles.length} saved page(s) into final PDF...`;
    job.progress = 95;
    console.log(`[${job.id}] Merging ${job.pageFiles.length} page file(s)...`);

    const mergedPdf = await PDFDocument.create();
    const sorted    = [...job.pageFiles].sort((a, b) => a.pageNum - b.pageNum);

    for (const { pageNum, filePath } of sorted) {
      try {
        const pageBytes = fs.readFileSync(filePath);
        const srcDoc    = await PDFDocument.load(pageBytes);
        const [copied]  = await mergedPdf.copyPages(srcDoc, [0]);
        mergedPdf.addPage(copied);
      } catch (mergeErr) {
        console.error(`[${job.id}] Merge error for page ${pageNum}:`, mergeErr.message);
      }
    }

    job.message  = 'Writing final PDF...';
    job.progress = 98;

    const outBytes   = await mergedPdf.save();
    const resultPath = path.join(os.tmpdir(), `${job.id}_result.pdf`);
    fs.writeFileSync(resultPath, outBytes);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const avgConf   = confidences.length
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;

    job.status        = 'done';
    job.progress      = 100;
    job.message       = 'Complete';
    job.resultPath    = resultPath;
    job.totalTime     = parseFloat(totalTime);
    job.avgConfidence = avgConf;
    job.eta           = 0;

    console.log(
      `[${job.id}] Done — ${job.pageFiles.length} pages merged, ` +
      `${(outBytes.length / 1024 / 1024).toFixed(1)} MB, ${totalTime}s, ` +
      `lang: ${getLangLabel(ocrLang)}`
    );

    for (const { filePath } of job.pageFiles) safeUnlink(filePath);
    job.pageFiles = [];
    safeUnlink(pdfPath);

  } catch (err) {
    if (worker) { try { await worker.terminate(); } catch (_) {} }
    safeUnlink(pdfPath);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────
// Global error handler
// ─────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err.message);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File too large — max ${MAX_FILE_MB} MB` });
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ScanLens OCR server v1.2.0 running on port ${PORT}`);
  console.log(`Auth: ${API_KEY ? 'enabled (X-API-Key)' : 'disabled'}`);
  console.log(`Max upload: ${MAX_FILE_MB} MB`);
  console.log(`Supported languages: English, Traditional/Simplified Chinese (H+V), Japanese (H+V), Korean`);
});
