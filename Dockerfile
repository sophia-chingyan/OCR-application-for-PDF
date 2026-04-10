FROM python:3.12-slim

# ── System deps: Tesseract OCR + language packs + poppler for pdf2image ──
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-chi-tra \
    tesseract-ocr-chi-tra-vert \
    tesseract-ocr-chi-sim \
    tesseract-ocr-chi-sim-vert \
    tesseract-ocr-jpn \
    tesseract-ocr-jpn-vert \
    tesseract-ocr-kor \
    poppler-utils \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Python deps ──
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── App code ──
COPY app.py .
COPY templates/ templates/

# ── Runtime dirs ──
RUN mkdir -p /tmp/scanlens/uploads /tmp/scanlens/outputs

# ── Zeabur uses PORT env var, default 8080 ──
ENV PORT=8080
EXPOSE 8080

# ── Use 1 worker to keep in-memory state consistent ──
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "8", "--timeout", "300", "app:app"]
