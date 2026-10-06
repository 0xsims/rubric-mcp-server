# HTTP mode is the default so a hosted endpoint can be scanned.
# initialize and tools/list need no API key. tools/call does.
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV PORT=8080
ENV RUBRIC_MCP_MODULES=core,x402
EXPOSE 8080
CMD ["node", "dist/index.js", "--http"]
