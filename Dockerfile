# HTTP mode is the default so a hosted endpoint can be scanned.
# initialize and tools/list need no API key. tools/call does.
# x402 paid tools are disabled in HTTP mode and will not use a server wallet key.
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV PORT=8080
ENV RUBRIC_MCP_MODULES=core
EXPOSE 8080
CMD ["node", "dist/index.js", "--http"]
