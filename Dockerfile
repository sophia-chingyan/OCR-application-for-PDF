FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# Copy application files
COPY server.js ./
COPY index.html ./
COPY library.html ./

# Zeabur persistent volume should be mounted at /data
# The server falls back to /app/data for local dev if DATA_DIR is not set
ENV DATA_DIR=/data

EXPOSE 8080

CMD ["node", "server.js"]
