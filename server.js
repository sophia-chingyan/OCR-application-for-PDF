const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 8080;

// Persistent storage directory — survives container restarts when a Zeabur
// volume is mounted at /data (configure via Zeabur dashboard: Volume path /data).
// Falls back to a local ./data directory for development.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const META_FILE = path.join(DATA_DIR, 'library.json');

// Ensure storage directories exist
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

// Load or initialise library metadata
function loadMeta() {
  try {
    if (fs.existsSync(META_FILE)) {
      return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load library metadata, starting fresh:', e.message);
  }
  return [];
}

function saveMeta(records) {
  try {
    fs.writeFileSync(META_FILE, JSON.stringify(records, null, 2));
  } catch (e) {
    console.error('Failed to persist library metadata:', e.message);
  }
}

// multer: store files on disk with their uuid-based filename
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, FILES_DIR),
  filename: (req, file, cb) => {
    const id = req.fileId || (req.fileId = uuidv4());
    cb(null, id + '.pdf');
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are accepted'));
    }
  }
});

app.use(express.json());

// Serve static HTML
app.use(express.static(__dirname, {
  index: 'index.html',
  extensions: ['html']
}));

// ── API ────────────────────────────────────────────────────────────────────

// GET /api/library — list all records (no blobs, just metadata)
app.get('/api/library', (req, res) => {
  const records = loadMeta();
  res.json(records);
});

// POST /api/library — upload a PDF and add it to the library
// Form fields: file (PDF binary), name (string), pages (number)
app.post('/api/library', (req, res) => {
  // Attach a pre-generated id so the diskStorage callback can use it
  req.fileId = uuidv4();

  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const id = req.fileId;
    const name = (req.body.name || req.file.originalname).replace(/[<>:"/\\|?*]/g, '_');
    const pages = parseInt(req.body.pages, 10) || 0;
    const size = req.file.size;

    // Duplicate check by name + size
    const records = loadMeta();
    if (records.some(r => r.name === name && r.size === size)) {
      // Remove the just-uploaded duplicate
      fs.unlink(req.file.path, () => {});
      return res.status(409).json({ error: 'already_saved', message: 'Already saved' });
    }

    const record = { id, name, size, pages, addedAt: Date.now() };
    records.push(record);
    saveMeta(records);

    res.status(201).json(record);
  });
});

// GET /api/library/:id — download a single file
app.get('/api/library/:id', (req, res) => {
  const records = loadMeta();
  const record = records.find(r => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found' });

  const filePath = path.join(FILES_DIR, record.id + '.pdf');
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(record.name)}"`);
  res.sendFile(filePath);
});

// PATCH /api/library/:id — rename a file
app.patch('/api/library/:id', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required' });
  }

  const records = loadMeta();
  const record = records.find(r => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found' });

  record.name = name.endsWith('.pdf') ? name : name + '.pdf';
  saveMeta(records);
  res.json(record);
});

// DELETE /api/library/:id — delete a single file
app.delete('/api/library/:id', (req, res) => {
  const records = loadMeta();
  const idx = records.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const [record] = records.splice(idx, 1);
  saveMeta(records);

  const filePath = path.join(FILES_DIR, record.id + '.pdf');
  fs.unlink(filePath, () => {});

  res.json({ ok: true });
});

// DELETE /api/library — clear entire library
app.delete('/api/library', (req, res) => {
  const records = loadMeta();
  records.forEach(r => fs.unlink(path.join(FILES_DIR, r.id + '.pdf'), () => {}));
  saveMeta([]);
  res.json({ ok: true });
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ScanLens server running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
