FROM node:22-alpine
LABEL "language"="nodejs"
LABEL "framework"="express"

WORKDIR /src

# Install system Tesseract and dependencies
RUN apk add --no-cache \
    tesseract-ocr \
    tesseract-ocr-data-eng \
    curl \
    ca-certificates

# Pre-download Tesseract training data
RUN mkdir -p /usr/share/tessdata && \
    curl -L https://github.com/UB-Mannheim/tesseract/wiki -o /dev/null && \
    wget -O /usr/share/tessdata/eng.traineddata https://github.com/UB-Mannheim/tesseract/raw/master/tessdata/eng.traineddata || \
    echo "Warning: Could not download training data"

COPY . .

RUN npm install -g pnpm && pnpm install

EXPOSE 8080

CMD ["pnpm", "run", "start"]
