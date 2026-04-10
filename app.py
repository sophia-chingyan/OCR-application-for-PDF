"""
ScanLens — PDF OCR Converter
Python/Flask rewrite of the original client-side app.
OCR is performed server-side using Tesseract via pytesseract.
Google OAuth2 authentication added.
"""

import os
import io
import re
import json
import time
import uuid
import shutil
import threading
import secrets
import hashlib
from pathlib import Path
from datetime import datetime
from functools import wraps
from urllib.parse import urlencode

import requests as http_requests
from flask import (
    Flask, render_template, request, jsonify, send_file,
    Response, stream_with_context, redirect, session, url_for, abort
)
from flask_cors import CORS
from PIL import Image, ImageEnhance, ImageFilter
import pytesseract
from pdf2image import convert_from_bytes
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch

app = Flask(__name__)
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB

# ── Secret key for sessions ──
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)

# ── Tell Flask it's behind a proxy so url_for generates https:// URLs ──
from werkzeug.middleware.proxy_fix import ProxyFix
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

# ── Google OAuth config ──
GOOGLE_CLIENT_ID     = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
ALLOW_EMAIL          = os.environ.get("ALLOW_EMAIL", "")   # comma-separated allowed emails

# Hard-coded redirect URI that always points to the production domain
REDIRECT_URI = "https://ocr-app.zeabur.app/auth/callback"

GOOGLE_AUTH_URL  = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", "/tmp/scanlens/uploads"))
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "/tmp/scanlens/outputs"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── In-memory stores ──
library: dict[str, dict] = {}
jobs:    dict[str, dict] = {}

# ── Language detection helpers ──
TRA_CHARS = set("國學數與對這經區體發聯當會從點問機關個義處應實來將過還後給讓說時種為開黨質裡類書閱讀寫說語陽陰電龍鳳鷹號")
SIM_CHARS = set("国学数与对这经区体发联当会从点问机关个义处应实来将过还后给让说时种为开党质里类书阅读写说语阳阴电龙凤鹰号")

LANG_LABELS = {
    "eng": "English",
    "chi_tra": "Traditional Chinese (Horizontal)",
    "chi_tra_vert": "Traditional Chinese (Vertical)",
    "chi_sim": "Simplified Chinese (Horizontal)",
    "chi_sim_vert": "Simplified Chinese (Vertical)",
    "jpn": "Japanese (Horizontal)",
    "jpn_vert": "Japanese (Vertical)",
    "kor": "Korean",
    "chi_tra+chi_sim+eng": "Chinese + English",
    "jpn+kor+eng": "Japanese + Korean + English",
}

try:
    _available_langs = set(pytesseract.get_languages())
except Exception:
    _available_langs = {"eng", "osd"}


# ═══════════════════════════════════════════════════════════
# Auth helpers
# ═══════════════════════════════════════════════════════════

def get_allowed_emails():
    """Return set of allowed emails (lowercased). Empty set = allow all authenticated users."""
    raw = ALLOW_EMAIL.strip()
    if not raw:
        return set()
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def is_authenticated():
    return bool(session.get("user_email"))


def require_auth(f):
    """Decorator: redirect to login if not authenticated."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not GOOGLE_CLIENT_ID:
            # OAuth not configured — allow all access
            return f(*args, **kwargs)
        if not is_authenticated():
            session["next"] = request.url
            return redirect(url_for("auth_login"))
        return f(*args, **kwargs)
    return decorated


def require_auth_api(f):
    """Decorator for API routes: return 401 JSON if not authenticated."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not GOOGLE_CLIENT_ID:
            return f(*args, **kwargs)
        if not is_authenticated():
            return jsonify({"error": "Unauthorized", "login_url": url_for("auth_login")}), 401
        return f(*args, **kwargs)
    return decorated


# ═══════════════════════════════════════════════════════════
# Auth routes
# ═══════════════════════════════════════════════════════════

@app.route("/auth/login")
def auth_login():
    if not GOOGLE_CLIENT_ID:
        return "OAuth not configured", 500

    state = secrets.token_urlsafe(32)
    session["oauth_state"] = state

    params = {
        "client_id":     GOOGLE_CLIENT_ID,
        "redirect_uri":  REDIRECT_URI,
        "response_type": "code",
        "scope":         "openid email profile",
        "state":         state,
        "prompt":        "select_account",
    }
    return redirect(f"{GOOGLE_AUTH_URL}?{urlencode(params)}")


@app.route("/auth/callback")
def auth_callback():
    # Validate state
    state = request.args.get("state", "")
    if not state or state != session.pop("oauth_state", None):
        return render_template("error.html",
                               title="Authentication Error",
                               message="Invalid OAuth state. Please try again."), 400

    error = request.args.get("error")
    if error:
        return render_template("error.html",
                               title="Login Denied",
                               message=f"Google returned an error: {error}"), 400

    code = request.args.get("code")
    if not code:
        return render_template("error.html",
                               title="Authentication Error",
                               message="No authorization code received."), 400

    # Exchange code for tokens
    try:
        token_resp = http_requests.post(GOOGLE_TOKEN_URL, data={
            "code":          code,
            "client_id":     GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "redirect_uri":  REDIRECT_URI,
            "grant_type":    "authorization_code",
        }, timeout=15)
        token_resp.raise_for_status()
        token_data = token_resp.json()
    except Exception as e:
        return render_template("error.html",
                               title="Token Exchange Failed",
                               message=str(e)), 500

    access_token = token_data.get("access_token")
    if not access_token:
        return render_template("error.html",
                               title="Authentication Error",
                               message="No access token returned by Google."), 500

    # Fetch user info
    try:
        user_resp = http_requests.get(GOOGLE_USERINFO_URL,
                                      headers={"Authorization": f"Bearer {access_token}"},
                                      timeout=10)
        user_resp.raise_for_status()
        user_info = user_resp.json()
    except Exception as e:
        return render_template("error.html",
                               title="User Info Fetch Failed",
                               message=str(e)), 500

    email = (user_info.get("email") or "").lower()
    name  = user_info.get("name") or email
    picture = user_info.get("picture") or ""

    # Check allow-list
    allowed = get_allowed_emails()
    if allowed and email not in allowed:
        return render_template("error.html",
                               title="Access Denied",
                               message=f"The account <strong>{email}</strong> is not authorised to use this app. Please contact the administrator."), 403

    # Store session
    session["user_email"]   = email
    session["user_name"]    = name
    session["user_picture"] = picture
    session.permanent = True

    next_url = session.pop("next", None) or url_for("index")
    return redirect(next_url)


@app.route("/auth/logout")
def auth_logout():
    session.clear()
    return redirect(url_for("index"))


@app.route("/auth/me")
def auth_me():
    if not is_authenticated():
        return jsonify({"authenticated": False})
    return jsonify({
        "authenticated": True,
        "email": session.get("user_email"),
        "name":  session.get("user_name"),
        "picture": session.get("user_picture"),
    })


# ═══════════════════════════════════════════════════════════
# Utility functions
# ═══════════════════════════════════════════════════════════

def get_lang_label(lang: str) -> str:
    return LANG_LABELS.get(lang, lang)


def detect_language(text: str) -> str:
    if not text or len(text.strip()) < 5:
        return "eng"
    cjk = eng = hangul = hiragana = katakana = 0
    tra_ind = sim_ind = 0
    for ch in text:
        code = ord(ch)
        if 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF:
            cjk += 1
            if ch in TRA_CHARS: tra_ind += 1
            if ch in SIM_CHARS: sim_ind += 1
        elif 0xAC00 <= code <= 0xD7A3: hangul += 1
        elif 0x3040 <= code <= 0x309F: hiragana += 1
        elif 0x30A0 <= code <= 0x30FF: katakana += 1
        elif (0x41 <= code <= 0x5A) or (0x61 <= code <= 0x7A): eng += 1
    jp_kana = hiragana + katakana
    total = cjk + eng + hangul + jp_kana
    if total == 0: return "eng"
    if hangul / total > 0.15: return "kor"
    if jp_kana > 0 and jp_kana / total > 0.05: return "jpn"
    if cjk / total > 0.25:
        if tra_ind > sim_ind * 1.2: return "chi_tra"
        if sim_ind > tra_ind * 1.2: return "chi_sim"
        return "chi_tra"
    return "eng"


def resolve_lang(lang_setting: str) -> str:
    if lang_setting == "auto": return "eng"
    parts = lang_setting.split("+")
    available = [p for p in parts if p in _available_langs]
    return "+".join(available) if available else "eng"


def enhance_image(img: Image.Image) -> Image.Image:
    enhancer = ImageEnhance.Contrast(img)
    img = enhancer.enhance(1.3)
    enhancer = ImageEnhance.Brightness(img)
    img = enhancer.enhance(1.05)
    return img


def create_text_layer_pdf(text: str, width: float, height: float) -> bytes:
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(width, height))
    c.setFont("Helvetica", 10)
    c.setFillAlpha(0)
    lines = text.split("\n")
    y = height - 20
    for line in lines:
        if line.strip():
            try: c.drawString(10, y, line.strip()[:200])
            except Exception: pass
        y -= 14
        if y < 20: break
    c.showPage(); c.save(); buf.seek(0)
    return buf.read()


def format_size(size_bytes: int) -> str:
    if size_bytes < 1024: return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024: return f"{size_bytes / 1024:.1f} KB"
    else: return f"{size_bytes / (1024 * 1024):.1f} MB"


def summarize_pages(pages: list[int]) -> str:
    if not pages: return ""
    if len(pages) <= 6: return ", ".join(str(p) for p in pages)
    ranges = []
    start = end = pages[0]
    for p in pages[1:]:
        if p == end + 1: end = p
        else:
            ranges.append(f"{start}" if start == end else f"{start}-{end}")
            start = end = p
    ranges.append(f"{start}" if start == end else f"{start}-{end}")
    return ", ".join(ranges)


def run_ocr_job(job_id: str, pdf_bytes: bytes, settings: dict):
    job = jobs[job_id]
    job["status"] = "running"
    job["logs"] = []

    def log(msg, level="info"):
        entry = {"time": datetime.now().strftime("%H:%M:%S"), "msg": msg, "level": level}
        job["logs"].append(entry)

    try:
        target_dpi = int(settings.get("dpi", 150))
        lang_setting = settings.get("lang", "auto")
        do_enhance = settings.get("enhance", True)
        selected_pages = sorted(settings.get("pages", []))

        log(f"OCR target: {len(selected_pages)} page(s) — [{summarize_pages(selected_pages)}]")
        log(f"Settings: {target_dpi} DPI, enhance: {'ON' if do_enhance else 'OFF'}")

        log("Converting PDF pages to images...")
        job["progress"] = 5
        job["detail"] = "Converting PDF to images..."

        all_images = convert_from_bytes(
            pdf_bytes, dpi=target_dpi, fmt="jpeg",
            first_page=min(selected_pages),
            last_page=max(selected_pages)
        )

        page_range_start = min(selected_pages)
        page_images = {}
        for i, img in enumerate(all_images):
            page_num = page_range_start + i
            if page_num in selected_pages:
                page_images[page_num] = img

        log(f"Converted {len(page_images)} page(s) to images", "success")

        ocr_lang = resolve_lang(lang_setting)
        if lang_setting == "auto" and page_images:
            first_img = list(page_images.values())[0]
            log("Auto-detecting language from first page...")
            try:
                sample_text = pytesseract.image_to_string(first_img, lang="eng")
                detected = detect_language(sample_text)
                ocr_lang = detected if detected in _available_langs else "eng"
                log(f"Language detected: {get_lang_label(ocr_lang)}", "success")
            except Exception as e:
                log(f"Detection failed, using English: {e}", "warn")
                ocr_lang = "eng"

        log(f"Using OCR model: {get_lang_label(ocr_lang)}")
        job["progress"] = 15
        job["detail"] = "Starting page processing..."

        original_reader = PdfReader(io.BytesIO(pdf_bytes))
        writer = PdfWriter()
        page_results = []
        start_time = time.time()

        for idx, page_num in enumerate(selected_pages):
            if job.get("cancelled"):
                log("Processing cancelled by user", "warn")
                break

            img = page_images.get(page_num)
            if img is None:
                log(f"Page {page_num}: image not available, skipping", "warn")
                continue

            progress = 15 + (idx / len(selected_pages)) * 75
            job["progress"] = progress
            job["detail"] = f"OCR page {page_num} ({idx + 1}/{len(selected_pages)})..."
            job["current_page"] = page_num

            if idx > 0:
                elapsed = time.time() - start_time
                per_page = elapsed / idx
                remaining = per_page * (len(selected_pages) - idx)
                job["eta"] = f"~{int(remaining)}s remaining ({per_page:.1f}s/page)"

            if do_enhance:
                img = enhance_image(img)

            log(f"Running OCR on page {page_num}...")
            try:
                ocr_data = pytesseract.image_to_data(img, lang=ocr_lang, output_type=pytesseract.Output.DICT)
                text = pytesseract.image_to_string(img, lang=ocr_lang)
                char_count = len(text.strip())
                confs = [int(c) for c in ocr_data["conf"] if int(c) > 0]
                avg_conf = sum(confs) / len(confs) if confs else 0
                level = "success" if avg_conf > 50 else "warn"
                log(f"Page {page_num}: {char_count} chars, confidence {avg_conf:.1f}%", level)
                page_results.append({"page": page_num, "text": text, "confidence": avg_conf, "chars": char_count})
            except Exception as e:
                log(f"OCR error on page {page_num}: {e}", "error")
                text = ""
                page_results.append({"page": page_num, "text": "", "confidence": 0, "chars": 0})

            orig_page = original_reader.pages[page_num - 1]
            writer.add_page(orig_page)

            if text.strip():
                page_w = float(orig_page.mediabox.width)
                page_h = float(orig_page.mediabox.height)
                text_pdf_bytes = create_text_layer_pdf(text, page_w, page_h)
                text_reader = PdfReader(io.BytesIO(text_pdf_bytes))
                if len(text_reader.pages) > 0:
                    writer.pages[-1].merge_page(text_reader.pages[0])

        if job.get("cancelled") and not page_results:
            job["status"] = "cancelled"
            return

        log(f"Merging {len(page_results)} page(s) into final PDF...")
        job["progress"] = 93
        job["detail"] = "Generating output PDF..."

        output_buf = io.BytesIO()
        writer.write(output_buf)
        output_buf.seek(0)
        output_bytes = output_buf.read()

        original_name = settings.get("filename", "document.pdf")
        ocr_name = re.sub(r"\.pdf$", "", original_name, flags=re.IGNORECASE) + "_OCR.pdf"
        output_path = OUTPUT_DIR / f"{job_id}_{ocr_name}"
        output_path.write_bytes(output_bytes)

        total_time = time.time() - start_time
        job["progress"] = 100
        job["detail"] = "Done!"
        job["eta"] = ""

        ocr_results = [r for r in page_results if r["confidence"] > 0]
        avg_conf = sum(r["confidence"] for r in ocr_results) / len(ocr_results) if ocr_results else 0

        log(f"Done! {len(page_results)} page(s), {format_size(len(output_bytes))}, {total_time:.1f}s total", "success")

        lib_id = uuid.uuid4().hex[:12]
        lib_entry = {
            "id": lib_id,
            "original_name": original_name,
            "ocr_name": ocr_name,
            "size_bytes": len(output_bytes),
            "size_label": format_size(len(output_bytes)),
            "page_count": len(page_results),
            "timestamp": int(time.time() * 1000),
            "output_path": str(output_path),
            "lang": get_lang_label(ocr_lang),
            "avg_confidence": round(avg_conf, 1),
            "total_time": round(total_time, 1),
        }
        library[lib_id] = lib_entry
        log("Saved to library", "success")

        job["status"] = "done"
        job["result"] = {
            "lib_id": lib_id,
            "ocr_name": ocr_name,
            "size_label": format_size(len(output_bytes)),
            "page_count": len(page_results),
            "total_pages": len(original_reader.pages),
            "avg_confidence": round(avg_conf, 1),
            "total_time": round(total_time, 1),
            "lang": get_lang_label(ocr_lang),
            "pages_processed": [r["page"] for r in page_results],
            "cancelled": bool(job.get("cancelled")),
        }

    except Exception as e:
        log(f"Fatal error: {e}", "error")
        job["status"] = "error"
        job["error"] = str(e)
        import traceback; traceback.print_exc()


# ═══════════════════════════════════════════════════════════
# Page routes
# ═══════════════════════════════════════════════════════════

@app.errorhandler(413)
def request_entity_too_large(error):
    return jsonify({"error": "File too large (max 100 MB)"}), 413

@app.errorhandler(Exception)
def handle_exception(error):
    code = getattr(error, "code", 500)
    return jsonify({"error": str(error)}), code


@app.route("/")
@require_auth
def index():
    return render_template("index.html",
                           user_name=session.get("user_name", ""),
                           user_email=session.get("user_email", ""),
                           user_picture=session.get("user_picture", ""),
                           auth_enabled=bool(GOOGLE_CLIENT_ID))


@app.route("/library.html")
@require_auth
def library_page():
    return render_template("library.html",
                           user_name=session.get("user_name", ""),
                           user_email=session.get("user_email", ""),
                           user_picture=session.get("user_picture", ""),
                           auth_enabled=bool(GOOGLE_CLIENT_ID))


# ═══════════════════════════════════════════════════════════
# API routes (all require auth)
# ═══════════════════════════════════════════════════════════

@app.route("/api/upload", methods=["POST"])
@require_auth_api
def upload_pdf():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
    chunk_index = request.form.get("chunk_index")
    if chunk_index is not None:
        return _handle_chunk()
    else:
        return _handle_single()


def _handle_single():
    file = request.files["file"]
    if not file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Only PDF files are supported"}), 400
    pdf_bytes = file.read()
    file_id = uuid.uuid4().hex[:12]
    file_path = UPLOAD_DIR / f"{file_id}.pdf"
    file_path.write_bytes(pdf_bytes)
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        page_count = len(reader.pages)
    except Exception as e:
        return jsonify({"error": f"Could not read PDF: {e}"}), 400
    return jsonify({
        "file_id": file_id,
        "filename": file.filename,
        "size": len(pdf_bytes),
        "size_label": format_size(len(pdf_bytes)),
        "page_count": page_count,
    })


def _handle_chunk():
    upload_id    = request.form.get("upload_id", "")
    chunk_index  = int(request.form.get("chunk_index", 0))
    total_chunks = int(request.form.get("total_chunks", 1))
    filename     = request.form.get("filename", "upload.pdf")
    if not upload_id:
        return jsonify({"error": "Missing upload_id"}), 400

    chunk_dir = UPLOAD_DIR / f"chunks_{upload_id}"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    chunk_path = chunk_dir / f"{chunk_index:06d}"
    chunk_path.write_bytes(request.files["file"].read())

    if chunk_index < total_chunks - 1:
        return jsonify({"ok": True, "chunk_index": chunk_index})

    chunk_files = sorted(chunk_dir.iterdir())
    file_id   = uuid.uuid4().hex[:12]
    file_path = UPLOAD_DIR / f"{file_id}.pdf"
    with open(file_path, "wb") as out:
        for cf in chunk_files:
            out.write(cf.read_bytes())
    shutil.rmtree(chunk_dir, ignore_errors=True)

    pdf_bytes = file_path.read_bytes()
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        page_count = len(reader.pages)
    except Exception as e:
        file_path.unlink(missing_ok=True)
        return jsonify({"error": f"Could not read PDF: {e}"}), 400

    return jsonify({
        "file_id": file_id,
        "filename": filename,
        "size": len(pdf_bytes),
        "size_label": format_size(len(pdf_bytes)),
        "page_count": page_count,
    })


@app.route("/api/ocr/start", methods=["POST"])
@require_auth_api
def start_ocr():
    if request.form.get("file_id"):
        file_id = request.form.get("file_id")
        lang    = request.form.get("lang", "auto")
        dpi     = int(request.form.get("dpi", 150) or 150)
        enhance_val = request.form.get("enhance", "1")
        enhance = enhance_val not in ("0", "false", "False")
        pages_raw = request.form.get("pages", "[]")
        try: pages = json.loads(pages_raw)
        except (json.JSONDecodeError, TypeError): pages = []
        filename = request.form.get("filename", "document.pdf")
    else:
        data     = request.get_json(force=True, silent=True) or {}
        file_id  = data.get("file_id")
        lang     = data.get("lang", "auto")
        dpi      = data.get("dpi", 150)
        enhance  = data.get("enhance", True)
        pages    = data.get("pages", [])
        filename = data.get("filename", "document.pdf")

    if not file_id:
        return jsonify({"error": "Missing file_id"}), 400

    file_path = UPLOAD_DIR / f"{file_id}.pdf"
    if not file_path.exists():
        return jsonify({"error": "File not found"}), 404

    pdf_bytes = file_path.read_bytes()
    job_id    = uuid.uuid4().hex[:12]
    settings  = {"lang": lang, "dpi": dpi, "enhance": enhance, "pages": pages, "filename": filename}

    if not settings["pages"]:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        settings["pages"] = list(range(1, len(reader.pages) + 1))

    jobs[job_id] = {"status": "queued", "progress": 0, "detail": "Queued...", "eta": "", "current_page": 0, "logs": []}

    thread = threading.Thread(target=run_ocr_job, args=(job_id, pdf_bytes, settings))
    thread.daemon = True
    thread.start()
    return jsonify({"job_id": job_id})


@app.route("/api/ocr/status/<job_id>")
@require_auth_api
def ocr_status(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify({
        "status":       job["status"],
        "progress":     job.get("progress", 0),
        "detail":       job.get("detail", ""),
        "eta":          job.get("eta", ""),
        "current_page": job.get("current_page", 0),
        "logs":         job.get("logs", []),
        "result":       job.get("result"),
        "error":        job.get("error"),
    })


@app.route("/api/ocr/cancel/<job_id>", methods=["POST"])
@require_auth_api
def cancel_ocr(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    job["cancelled"] = True
    return jsonify({"ok": True})


@app.route("/api/library", methods=["GET", "POST"])
@require_auth_api
def library_endpoint():
    if request.method == "GET":
        items = sorted(library.values(), key=lambda x: x["timestamp"], reverse=True)
        return jsonify(items)

    action = request.form.get("action", "")
    lib_id = request.form.get("id", "")

    if action == "delete":
        entry = library.pop(lib_id, None)
        if not entry:
            return jsonify({"error": "Not found"}), 404
        try: Path(entry["output_path"]).unlink(missing_ok=True)
        except Exception: pass
        return jsonify({"ok": True})

    elif action == "clear":
        for entry in library.values():
            try: Path(entry["output_path"]).unlink(missing_ok=True)
            except Exception: pass
        library.clear()
        return jsonify({"ok": True})

    elif action == "rename":
        entry = library.get(lib_id)
        if not entry:
            return jsonify({"error": "Not found"}), 404
        new_name = (request.form.get("name") or "").strip()
        if new_name:
            if not new_name.endswith(".pdf"): new_name += ".pdf"
            entry["ocr_name"] = new_name
        return jsonify({"ok": True, "name": entry["ocr_name"]})

    return jsonify({"error": "Unknown action"}), 400


@app.route("/api/download/<lib_id>")
@require_auth_api
def download_file(lib_id):
    entry = library.get(lib_id)
    if not entry:
        return jsonify({"error": "Not found"}), 404
    path = Path(entry["output_path"])
    if not path.exists():
        return jsonify({"error": "File not found on disk"}), 404
    return send_file(path, mimetype="application/pdf", as_attachment=True, download_name=entry["ocr_name"])


@app.route("/api/languages")
@require_auth_api
def get_languages():
    return jsonify(sorted(list(_available_langs - {"osd"})))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)
