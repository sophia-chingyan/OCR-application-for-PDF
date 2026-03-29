FROM node:22-alpine
LABEL "language"="nodejs"
LABEL "framework"="express"
WORKDIR /app
RUN mkdir -p /app/uploads /app/results
COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
