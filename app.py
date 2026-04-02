"""
ScanLens — PDF OCR Converter
Python/Flask rewrite of the original client-side app.
OCR is performed server-side using Tesseract via pytesseract.
"""

import os
import io
import re
import json
import time
import uuid
import shutil
import threading
from pathlib import Path
from datetime import datetime

from flask import (
    Flask, render_template, request, jsonify, send_file,
    Response, stream_with_context
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
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB limit (legacy single-file upload)

UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", "/tmp/scanlens/uploads"))
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "/tmp/scanlens/outputs"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── In-memory library store ──
library: dict[str, dict] = {}
# ── In-progress jobs ──
jobs: dict[str, dict] = {}
# ── Chunked upload tracking ──
uploads: dict[str, dict] = {}

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

# Check which tesseract languages are actually installed
try:
    _available_langs = set(pytesseract.get_languages())
except Exception:
    _available_langs = {"eng", "osd"}


def get_lang_label(lang: str) -> str:
    return LANG_LABELS.get(lang, lang)


def detect_language(text: str) -> str:
    """Detect language from OCR'd text based on character frequency."""
    if not text or len(text.strip()) < 5:
        return "eng"

    cjk = eng = hangul = hiragana = katakana = 0
    tra_ind = sim_ind = 0

    for ch in text:
        code = ord(ch)
        if 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF:
            cjk += 1
            if ch in TRA_CHARS:
                tra_ind += 1
            if ch in SIM_CHARS:
                sim_ind += 1
        elif 0xAC00 <= code <= 0xD7A3:
            hangul += 1
        elif 0x3040 <= code <= 0x309F:
            hiragana += 1
        elif 0x30A0 <= code <= 0x30FF:
            katakana += 1
        elif (0x41 <= code <= 0x5A) or (0x61 <= code <= 0x7A):
            eng += 1

    jp_kana = hiragana + katakana
    total = cjk + eng + hangul + jp_kana
    if total == 0:
        return "eng"
    if hangul / total > 0.15:
        return "kor"
    if jp_kana > 0 and jp_kana / total > 0.05:
        return "jpn"
    if cjk / total > 0.25:
        if tra_ind > sim_ind * 1.2:
            return "chi_tra"
        if sim_ind > tra_ind * 1.2:
            return "chi_sim"
        return "chi_tra"
    return "eng"


def resolve_lang(lang_setting: str) -> str:
    """Resolve the language, falling back to 'eng' for unavailable ones."""
    if lang_setting == "auto":
        return "eng"  # will be detected per-page
    parts = lang_setting.split("+")
    available = [p for p in parts if p in _available_langs]
    return "+".join(available) if available else "eng"


def enhance_image(img: Image.Image) -> Image.Image:
    """Apply contrast and brightness boost for better OCR on camera photos."""
    enhancer = ImageEnhance.Contrast(img)
    img = enhancer.enhance(1.3)
    enhancer = ImageEnhance.Brightness(img)
    img = enhancer.enhance(1.05)
    return img


def create_text_layer_pdf(text: str, width: float, height: float) -> bytes:
    """Create a transparent PDF page with invisible text overlay."""
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(width, height))
    c.setFont("Helvetica", 10)
    c.setFillAlpha(0)  # invisible text

    lines = text.split("\n")
    y = height - 20
    for line in lines:
        if line.strip():
            try:
                c.drawString(10, y, line.strip()[:200])
            except Exception:
                pass
        y -= 14
        if y < 20:
            break

    c.showPage()
    c.save()
    buf.seek(0)
    return buf.read()


def format_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.1f} MB"


def summarize_pages(pages: list[int]) -> str:
    if not pages:
        return ""
    if len(pages) <= 6:
        return ", ".join(str(p) for p in pages)
    ranges = []
    start = end = pages[0]
    for p in pages[1:]:
        if p == end + 1:
            end = p
        else:
            ranges.append(f"{start}" if start == end else f"{start}-{end}")
            start = end = p
    ranges.append(f"{start}" if start == end else f"{start}-{end}")
    return ", ".join(ranges)


def run_ocr_job(job_id: str, pdf_bytes: bytes, settings: dict):
    """Background OCR processing."""
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

        # Convert PDF pages to images
        log("Converting PDF pages to images...")
        job["progress"] = 5
        job["detail"] = "Converting PDF to images..."

        all_images = convert_from_bytes(
            pdf_bytes, dpi=target_dpi, fmt="jpeg",
            first_page=min(selected_pages),
            last_page=max(selected_pages)
        )

        # Build page-to-image mapping
        page_range_start = min(selected_pages)
        page_images = {}
        for i, img in enumerate(all_images):
            page_num = page_range_start + i
            if page_num in selected_pages:
                page_images[page_num] = img

        log(f"Converted {len(page_images)} page(s) to images", "success")

        # Detect language if auto
        ocr_lang = resolve_lang(lang_setting)
        if lang_setting == "auto" and page_images:
            first_img = list(page_images.values())[0]
            log("Auto-detecting language from first page...")
            try:
                sample_text = pytesseract.image_to_string(first_img, lang="eng")
                detected = detect_language(sample_text)
                if detected in _available_langs:
                    ocr_lang = detected
                else:
                    ocr_lang = "eng"
                log(f"Language detected: {get_lang_label(ocr_lang)}", "success")
            except Exception as e:
                log(f"Detection failed, using English: {e}", "warn")
                ocr_lang = "eng"

        log(f"Using OCR model: {get_lang_label(ocr_lang)}")
        job["progress"] = 15
        job["detail"] = "Starting page processing..."

        # Read original PDF for merging
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

            # Enhance if requested
            if do_enhance:
                img = enhance_image(img)

            # Run OCR
            log(f"Running OCR on page {page_num}...")
            try:
                ocr_data = pytesseract.image_to_data(
                    img, lang=ocr_lang, output_type=pytesseract.Output.DICT
                )
                text = pytesseract.image_to_string(img, lang=ocr_lang)
                char_count = len(text.strip())

                # Calculate average confidence
                confs = [int(c) for c in ocr_data["conf"] if int(c) > 0]
                avg_conf = sum(confs) / len(confs) if confs else 0

                level = "success" if avg_conf > 50 else "warn"
                log(f"Page {page_num}: {char_count} chars, confidence {avg_conf:.1f}%", level)

                page_results.append({
                    "page": page_num,
                    "text": text,
                    "confidence": avg_conf,
                    "chars": char_count,
                })
            except Exception as e:
                log(f"OCR error on page {page_num}: {e}", "error")
                text = ""
                page_results.append({
                    "page": page_num, "text": "", "confidence": 0, "chars": 0
                })

            # Add original page to writer
            orig_page = original_reader.pages[page_num - 1]
            writer.add_page(orig_page)

            # Overlay text layer
            if text.strip():
                page_w = float(orig_page.mediabox.width)
                page_h = float(orig_page.mediabox.height)
                text_pdf_bytes = create_text_layer_pdf(text, page_w, page_h)
                text_reader = PdfReader(io.BytesIO(text_pdf_bytes))
                if len(text_reader.pages) > 0:
                    current_page = writer.pages[-1]
                    current_page.merge_page(text_reader.pages[0])

        if job.get("cancelled") and not page_results:
            job["status"] = "cancelled"
            return

        # Write output PDF
        log(f"Merging {len(page_results)} page(s) into final PDF...")
        job["progress"] = 93
        job["detail"] = "Generating output PDF..."

        output_buf = io.BytesIO()
        writer.write(output_buf)
        output_buf.seek(0)
        output_bytes = output_buf.read()

        # Save output file
        original_name = settings.get("filename", "document.pdf")
        ocr_name = re.sub(r"\.pdf$", "", original_name, flags=re.IGNORECASE) + "_OCR.pdf"
        output_path = OUTPUT_DIR / f"{job_id}_{ocr_name}"
        output_path.write_bytes(output_bytes)

        total_time = time.time() - start_time
        job["progress"] = 100
        job["detail"] = "Done!"
        job["eta"] = ""

        # Calculate stats
        ocr_results = [r for r in page_results if r["confidence"] > 0]
        avg_conf = (
            sum(r["confidence"] for r in ocr_results) / len(ocr_results)
            if ocr_results else 0
        )

        log(
            f"Done! {len(page_results)} page(s), "
            f"{format_size(len(output_bytes))}, {total_time:.1f}s total",
            "success",
        )

        # Save to library
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
        import traceback
        traceback.print_exc()


# ═══════════════════════════════════════════════════════════
# Routes
# ═══════════════════════════════════════════════════════════

@app.errorhandler(413)
def request_entity_too_large(error):
    return jsonify({"error": "File too large (max 100 MB)"}), 413


@app.errorhandler(Exception)
def handle_exception(error):
    code = getattr(error, "code", 500)
    return jsonify({"error": str(error)}), code


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/library.html")
def library_page():
    return render_template("library.html")


@app.route("/api/upload", methods=["POST"])
def upload_pdf():
    """Upload a PDF and get page count info."""
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

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


@app.route("/api/upload/init", methods=["POST"])
def upload_init():
    """Initialize a chunked upload session."""
    data = request.get_json(force=True, silent=True) or {}
    filename = data.get("filename", "")
    total_size = data.get("size", 0)

    if not filename.lower().endswith(".pdf"):
        return jsonify({"error": "Only PDF files are supported"}), 400
    if total_size > 100 * 1024 * 1024:
        return jsonify({"error": "File too large (max 100 MB)"}), 400

    upload_id = uuid.uuid4().hex[:12]
    chunk_dir = UPLOAD_DIR / f"chunks_{upload_id}"
    chunk_dir.mkdir(parents=True, exist_ok=True)

    uploads[upload_id] = {
        "filename": filename,
        "total_size": total_size,
        "received": 0,
        "chunk_count": 0,
        "chunk_dir": str(chunk_dir),
    }

    return jsonify({"upload_id": upload_id})


@app.route("/api/upload/chunk", methods=["POST"])
def upload_chunk():
    """Receive a single chunk of a file."""
    upload_id = request.form.get("upload_id")
    chunk_index = request.form.get("index")

    if not upload_id or upload_id not in uploads:
        return jsonify({"error": "Invalid upload_id"}), 400

    if "chunk" not in request.files:
        return jsonify({"error": "No chunk data"}), 400

    info = uploads[upload_id]
    chunk = request.files["chunk"]
    chunk_data = chunk.read()

    chunk_path = Path(info["chunk_dir"]) / f"{int(chunk_index):06d}"
    chunk_path.write_bytes(chunk_data)

    info["received"] += len(chunk_data)
    info["chunk_count"] += 1

    return jsonify({"ok": True, "received": info["received"]})


@app.route("/api/upload/complete", methods=["POST"])
def upload_complete():
    """Assemble chunks into a final PDF and return file info."""
    data = request.get_json(force=True, silent=True) or {}
    upload_id = data.get("upload_id")

    if not upload_id or upload_id not in uploads:
        return jsonify({"error": "Invalid upload_id"}), 400

    info = uploads[upload_id]
    chunk_dir = Path(info["chunk_dir"])
    chunk_files = sorted(chunk_dir.iterdir())

    if not chunk_files:
        return jsonify({"error": "No chunks received"}), 400

    file_id = uuid.uuid4().hex[:12]
    file_path = UPLOAD_DIR / f"{file_id}.pdf"

    with open(file_path, "wb") as out:
        for cf in chunk_files:
            out.write(cf.read_bytes())

    # Clean up chunks
    shutil.rmtree(chunk_dir, ignore_errors=True)
    del uploads[upload_id]

    pdf_bytes = file_path.read_bytes()

    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        page_count = len(reader.pages)
    except Exception as e:
        file_path.unlink(missing_ok=True)
        return jsonify({"error": f"Could not read PDF: {e}"}), 400

    return jsonify({
        "file_id": file_id,
        "filename": info["filename"],
        "size": len(pdf_bytes),
        "size_label": format_size(len(pdf_bytes)),
        "page_count": page_count,
    })


@app.route("/api/ocr/start", methods=["POST"])
def start_ocr():
    """Start an OCR job."""
    data = request.get_json(force=True, silent=True) or {}
    file_id = data.get("file_id")
    if not file_id:
        return jsonify({"error": "Missing file_id"}), 400

    file_path = UPLOAD_DIR / f"{file_id}.pdf"
    if not file_path.exists():
        return jsonify({"error": "File not found"}), 404

    pdf_bytes = file_path.read_bytes()
    job_id = uuid.uuid4().hex[:12]

    settings = {
        "lang": data.get("lang", "auto"),
        "dpi": data.get("dpi", 150),
        "enhance": data.get("enhance", True),
        "pages": data.get("pages", []),
        "filename": data.get("filename", "document.pdf"),
    }

    # If no pages specified, process all
    if not settings["pages"]:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        settings["pages"] = list(range(1, len(reader.pages) + 1))

    jobs[job_id] = {
        "status": "queued",
        "progress": 0,
        "detail": "Queued...",
        "eta": "",
        "current_page": 0,
        "logs": [],
    }

    thread = threading.Thread(target=run_ocr_job, args=(job_id, pdf_bytes, settings))
    thread.daemon = True
    thread.start()

    return jsonify({"job_id": job_id})


@app.route("/api/ocr/status/<job_id>")
def ocr_status(job_id):
    """Poll job status."""
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    return jsonify({
        "status": job["status"],
        "progress": job.get("progress", 0),
        "detail": job.get("detail", ""),
        "eta": job.get("eta", ""),
        "current_page": job.get("current_page", 0),
        "logs": job.get("logs", []),
        "result": job.get("result"),
        "error": job.get("error"),
    })


@app.route("/api/ocr/cancel/<job_id>", methods=["POST"])
def cancel_ocr(job_id):
    """Cancel an OCR job."""
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    job["cancelled"] = True
    return jsonify({"ok": True})


@app.route("/api/library")
def get_library():
    """Get all library entries."""
    items = sorted(library.values(), key=lambda x: x["timestamp"], reverse=True)
    return jsonify(items)


@app.route("/api/library/<lib_id>", methods=["DELETE"])
def delete_library_item(lib_id):
    """Delete a library entry."""
    entry = library.pop(lib_id, None)
    if not entry:
        return jsonify({"error": "Not found"}), 404
    try:
        Path(entry["output_path"]).unlink(missing_ok=True)
    except Exception:
        pass
    return jsonify({"ok": True})


@app.route("/api/library/clear", methods=["POST"])
def clear_library():
    """Clear entire library."""
    for entry in library.values():
        try:
            Path(entry["output_path"]).unlink(missing_ok=True)
        except Exception:
            pass
    library.clear()
    return jsonify({"ok": True})


@app.route("/api/library/<lib_id>/rename", methods=["POST"])
def rename_library_item(lib_id):
    """Rename a library entry."""
    entry = library.get(lib_id)
    if not entry:
        return jsonify({"error": "Not found"}), 404
    new_name = request.json.get("name", "").strip()
    if new_name:
        if not new_name.endswith(".pdf"):
            new_name += ".pdf"
        entry["ocr_name"] = new_name
    return jsonify({"ok": True, "name": entry["ocr_name"]})


@app.route("/api/download/<lib_id>")
def download_file(lib_id):
    """Download a processed PDF."""
    entry = library.get(lib_id)
    if not entry:
        return jsonify({"error": "Not found"}), 404
    path = Path(entry["output_path"])
    if not path.exists():
        return jsonify({"error": "File not found on disk"}), 404
    return send_file(
        path,
        mimetype="application/pdf",
        as_attachment=True,
        download_name=entry["ocr_name"],
    )


@app.route("/api/languages")
def get_languages():
    """Return available Tesseract languages."""
    return jsonify(sorted(list(_available_langs - {"osd"})))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)
