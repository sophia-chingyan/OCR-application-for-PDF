FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY library-api.js ./
COPY index.html ./
COPY library.html ./

RUN mkdir -p /data

ENV PORT=8080
ENV LIBRARY_DATA_DIR=/data

EXPOSE 8080

CMD ["npm", "start"]
