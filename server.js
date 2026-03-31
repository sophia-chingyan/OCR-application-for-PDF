const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '8080', 10);
const PREFERRED_DATA_DIR = process.env.LIBRARY_DATA_DIR || '/data';
let storageRoot = PREFERRED_DATA_DIR;
let metadataWriteQueue = Promise.resolve();

function getLibraryDir() {
  return path.join(storageRoot, 'library');
}

function getFilesDir() {
  return path.join(getLibraryDir(), 'files');
}

function getMetaFile() {
  return path.join(getLibraryDir(), 'metadata.json');
}
const STATIC_FILES = {
  '/': path.join(__dirname, 'index.html'),
  '/index.html': path.join(__dirname, 'index.html'),
  '/library.html': path.join(__dirname, 'library.html'),
  '/library-api.js': path.join(__dirname, 'library-api.js')
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf'
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text)
  });
  res.end(text);
}

function sanitizeFilename(name) {
  const normalized = (name || 'document.pdf').replace(/[/\\?%*:|"<>]/g, '-').trim();
  return normalized.toLowerCase().endsWith('.pdf') ? normalized : `${normalized}.pdf`;
}

function generateId() {
  return crypto.randomBytes(12).toString('hex');
}

async function ensureStorage() {
  const candidates = [PREFERRED_DATA_DIR, path.join(__dirname, 'data')];
  let lastError = null;
  for (const candidate of candidates) {
    try {
      storageRoot = candidate;
      await fsp.mkdir(getFilesDir(), { recursive: true });
      try {
        await fsp.access(getMetaFile(), fs.constants.F_OK);
      } catch {
        await fsp.writeFile(getMetaFile(), '[]\n', 'utf8');
      }
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Unable to initialize storage');
}

async function readMetadata() {
  await ensureStorage();
  try {
    const raw = await fsp.readFile(getMetaFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeMetadata(records) {
  metadataWriteQueue = metadataWriteQueue.then(async () => {
    await ensureStorage();
    await fsp.writeFile(getMetaFile(), `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  });
  await metadataWriteQueue;
}

function publicRecord(record) {
  return {
    id: record.id,
    name: record.name,
    size: record.size,
    pages: record.pages ?? null,
    addedAt: record.addedAt,
    filePath: `/api/library/files/${record.id}`
  };
}

async function collectBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100 * 1024 * 1024) {
      throw new Error('Request body too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseMultipart(buffer, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const parts = [];
  let searchStart = 0;

  while (true) {
    const boundaryIndex = buffer.indexOf(boundaryBuffer, searchStart);
    if (boundaryIndex === -1) break;
    const afterBoundary = boundaryIndex + boundaryBuffer.length;
    if (buffer.slice(afterBoundary, afterBoundary + 2).toString() === '--') break;
    const partStart = afterBoundary + 2;
    const nextBoundaryIndex = buffer.indexOf(boundaryBuffer, partStart);
    if (nextBoundaryIndex === -1) break;
    const partBuffer = buffer.slice(partStart, nextBoundaryIndex - 2);
    const headerEnd = partBuffer.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) {
      searchStart = nextBoundaryIndex;
      continue;
    }
    const headersRaw = partBuffer.slice(0, headerEnd).toString('utf8');
    const content = partBuffer.slice(headerEnd + 4);
    const headers = {};
    for (const line of headersRaw.split('\r\n')) {
      const sep = line.indexOf(':');
      if (sep !== -1) {
        headers[line.slice(0, sep).trim().toLowerCase()] = line.slice(sep + 1).trim();
      }
    }
    parts.push({ headers, content });
    searchStart = nextBoundaryIndex;
  }

  return parts;
}

function parseContentDisposition(value) {
  const params = {};
  for (const segment of value.split(';')) {
    const trimmed = segment.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    let val = trimmed.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return params;
}

async function parseUploadRequest(req) {
  const contentType = req.headers['content-type'] || '';
  const match = contentType.match(/multipart\/form-data;\s*boundary=(.+)$/i);
  if (!match) {
    throw new Error('Expected multipart/form-data upload');
  }

  const body = await collectBody(req);
  const parts = parseMultipart(body, match[1]);
  const fields = {};
  let uploadedFile = null;

  for (const part of parts) {
    const disposition = part.headers['content-disposition'];
    if (!disposition) continue;
    const params = parseContentDisposition(disposition);
    if (!params.name) continue;
    if (params.filename) {
      uploadedFile = {
        fieldName: params.name,
        filename: params.filename,
        contentType: part.headers['content-type'] || 'application/octet-stream',
        buffer: part.content
      };
    } else {
      fields[params.name] = part.content.toString('utf8');
    }
  }

  if (!uploadedFile || uploadedFile.fieldName !== 'file') {
    throw new Error('Missing uploaded file');
  }

  return { fields, file: uploadedFile };
}

async function saveUploadedFile(req, res) {
  let parsed;
  try {
    parsed = await parseUploadRequest(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const { fields, file } = parsed;
  const name = sanitizeFilename(fields.name || file.filename || 'document.pdf');
  const pagesRaw = fields.pages ? parseInt(fields.pages, 10) : null;
  const pages = Number.isFinite(pagesRaw) && pagesRaw > 0 ? pagesRaw : null;

  if (file.contentType !== 'application/pdf' && !name.toLowerCase().endsWith('.pdf')) {
    sendJson(res, 400, { error: 'Only PDF files are supported' });
    return;
  }

  const records = await readMetadata();
  const duplicate = records.find(record => record.name === name && record.size === file.buffer.length);
  if (duplicate) {
    sendJson(res, 200, { duplicate: true, record: publicRecord(duplicate) });
    return;
  }

  const id = generateId();
  const diskName = `${id}.pdf`;
  const savedPath = path.join(getFilesDir(), diskName);
  const record = {
    id,
    diskName,
    name,
    size: file.buffer.length,
    pages,
    addedAt: Date.now()
  };

  await fsp.writeFile(savedPath, file.buffer);
  records.unshift(record);
  await writeMetadata(records);
  sendJson(res, 201, { duplicate: false, record: publicRecord(record) });
}

async function listFiles(res) {
  const records = await readMetadata();
  sendJson(res, 200, { files: records.map(publicRecord) });
}

async function serveStoredFile(res, id) {
  const records = await readMetadata();
  const record = records.find(item => item.id === id);
  if (!record) {
    sendJson(res, 404, { error: 'File not found' });
    return;
  }
  const filePath = path.join(getFilesDir(), record.diskName);
  try {
    const stat = await fsp.stat(filePath);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${record.name.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { error: 'Stored file missing' });
  }
}

async function renameFile(req, res, id) {
  const body = await collectBody(req);
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const newName = sanitizeFilename(parsed.name || '');
  if (!newName) {
    sendJson(res, 400, { error: 'Name is required' });
    return;
  }

  const records = await readMetadata();
  const record = records.find(item => item.id === id);
  if (!record) {
    sendJson(res, 404, { error: 'File not found' });
    return;
  }

  record.name = newName;
  await writeMetadata(records);
  sendJson(res, 200, { record: publicRecord(record) });
}

async function deleteFile(res, id) {
  const records = await readMetadata();
  const record = records.find(item => item.id === id);
  if (!record) {
    sendJson(res, 404, { error: 'File not found' });
    return;
  }

  const nextRecords = records.filter(item => item.id !== id);
  await writeMetadata(nextRecords);
  await fsp.rm(path.join(getFilesDir(), record.diskName), { force: true });
  sendJson(res, 200, { deleted: true });
}

async function clearLibrary(res) {
  const records = await readMetadata();
  await Promise.all(records.map(record => fsp.rm(path.join(getFilesDir(), record.diskName), { force: true })));
  await writeMetadata([]);
  sendJson(res, 200, { cleared: true });
}

async function serveStatic(res, filePath) {
  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
    });
    res.end(data);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/api/library') {
      await listFiles(res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/library') {
      await saveUploadedFile(req, res);
      return;
    }

    if (req.method === 'DELETE' && pathname === '/api/library') {
      await clearLibrary(res);
      return;
    }

    const fileMatch = pathname.match(/^\/api\/library\/files\/([a-f0-9]+)$/);
    if (fileMatch) {
      const id = fileMatch[1];
      if (req.method === 'GET') {
        await serveStoredFile(res, id);
        return;
      }
      if (req.method === 'PATCH') {
        await renameFile(req, res, id);
        return;
      }
      if (req.method === 'DELETE') {
        await deleteFile(res, id);
        return;
      }
    }

    if (req.method === 'GET' && STATIC_FILES[pathname]) {
      await serveStatic(res, STATIC_FILES[pathname]);
      return;
    }

    sendText(res, 404, 'Not found');
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

ensureStorage()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`ScanLens server listening on port ${PORT}`);
      console.log(`Library storage directory: ${getLibraryDir()}`);
    });
  })
  .catch(error => {
    console.error('Failed to initialize storage', error);
    process.exit(1);
  });
