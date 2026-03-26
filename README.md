# ScanLens — Zeabur Deployment Guide

## What you get

| File | Purpose |
|---|---|
| `index.html` | Frontend — open in any browser |
| `server.js` | Backend — deploy to Zeabur |
| `package.json` | Node.js dependencies |

---

## Deploying the server to Zeabur

### Option A — GitHub (recommended)

1. Create a new GitHub repo and push `server.js` + `package.json`
2. Go to [zeabur.com](https://zeabur.com) → New Project → Deploy from GitHub
3. Select your repo — Zeabur auto-detects Node.js
4. Add environment variables (optional):

   | Variable | Value | Notes |
   |---|---|---|
   | `API_KEY` | `your-secret-key` | Leave blank to disable auth |
   | `MAX_FILE_MB` | `100` | Max upload size in MB |

5. Click **Deploy** — Zeabur assigns a URL like `https://your-app.zeabur.app`

### Option B — Zeabur CLI

```bash
npm install -g @zeabur/cli
zeabur login
zeabur deploy
```

---

## Connecting the frontend

1. Open `index.html` in your browser
2. In **OCR Settings**, switch **Processing Mode** to **Zeabur Server**
3. Enter your Zeabur URL: `https://your-app.zeabur.app`
4. Enter your API Key (if you set one)
5. Click **Test** to verify the connection
6. Upload a PDF and click **☁ Upload to Zeabur**

---

## API reference

The server exposes these endpoints:

### `GET /api/health`
Returns server status. Used by the Test button.
```json
{ "status": "ok", "version": "1.0.0", "uptime": 120, "maxFileMB": 100 }
```

### `POST /api/ocr`
Upload PDF + settings. Returns a job ID immediately.

**Headers:** `X-API-Key: your-key` (if auth is enabled)

**Body (multipart/form-data):**
| Field | Type | Description |
|---|---|---|
| `file` | PDF file | The scanned PDF |
| `pages` | JSON array | e.g. `[1,2,3]` — omit for all pages |
| `lang` | string | `auto`, `eng`, `chi_tra`, `chi_sim`, `chi_tra+chi_sim+eng` |
| `dpi` | number | `150`, `200`, or `300` |
| `enhance` | string | `"true"` or `"false"` |

**Response:**
```json
{ "jobId": "uuid-here", "message": "Job accepted" }
```

### `GET /api/ocr/:jobId/status`
Poll this every 2 seconds during processing.
```json
{
  "jobId": "...",
  "status": "processing",       // queued | processing | done | error | cancelled
  "progress": 45,               // 0–100
  "message": "OCR page 3 (3/8)",
  "completedPages": 2,
  "totalPages": 8,
  "eta": 12,                    // seconds remaining
  "totalTime": null,            // set when done
  "avgConfidence": null         // set when done
}
```

### `GET /api/ocr/:jobId/result`
Download the final searchable PDF (only when `status === "done"`).

### `POST /api/ocr/:jobId/cancel`
Request cancellation of a running job.

---

## Notes

- Jobs and result files are automatically deleted after **30 minutes**
- The server uses Tesseract.js — same OCR engine as the browser, but without memory limits
- For very large PDFs (50+ pages at 300 DPI), allocate at least 1 GB RAM in Zeabur
- CORS is open (`*`) — restrict it in `server.js` if needed for production
