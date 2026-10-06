import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bindProcessTransport, createMcpServer, listEnabledTools, packageVersion, runWithHttpRequest, SERVER_NAME } from "./index.js";

const MAX_BODY_BYTES = 1_048_576;
const RATE_WINDOW_MS = 60_000;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const hits = new Map<string, number[]>();

export function buildServerCard() {
  return {
    serverInfo: { name: SERVER_NAME, version: packageVersion() },
    authentication: {
      required: true,
      schemes: ["bearer"],
      description: "tools/call requires Authorization: Bearer or an x-api-key header. initialize and tools/list do not require authentication.",
    },
    tools: listEnabledTools("http"),
    resources: [] as unknown[],
    prompts: [] as unknown[],
  };
}

function listenPort(): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw === "") return 3000;
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) throw new Error(`Invalid PORT: ${raw}`);
  return Number(raw);
}

function bindHost(): string {
  const host = (process.env.HOST ?? "").trim();
  return host || "127.0.0.1";
}

function headerValue(value: string | string[] | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return "";
}

function csvEnv(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}

function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  return host.replace(/:\d+$/, "");
}

function allowedHostNames(): string[] {
  const configured = csvEnv("TENPRINT_ALLOWED_HOSTS");
  return configured.length > 0 ? configured : ["127.0.0.1", "localhost", "::1", "[::1]"];
}

function hostAllowed(host: string): boolean {
  if (!host) return false;
  const names = allowedHostNames();
  if (names.includes(host)) return true;
  return names.includes(stripPort(host));
}

function originAllowed(origin: string): boolean {
  if (!origin) return true;
  return csvEnv("TENPRINT_ALLOWED_ORIGINS").includes(origin);
}

function sdkAllowedHosts(port: number): string[] {
  const hosts = new Set<string>();
  for (const name of allowedHostNames()) {
    hosts.add(name);
    if (name.startsWith("[")) hosts.add(`${name}:${port}`);
    else if (!/:\d+$/.test(name)) hosts.add(`${name}:${port}`);
  }
  return [...hosts];
}

/** Bearer token, then the x-api-key header the upstream API already uses. */
export function requestApiKey(req: IncomingMessage): string {
  const authorization = headerValue(req.headers.authorization);
  const bearer = /^Bearer\s+(\S+)/i.exec(authorization);
  if (bearer?.[1]) return bearer[1];
  return headerValue(req.headers["x-api-key"]);
}

function isToolsCall(message: unknown): boolean {
  return Boolean(message && typeof message === "object" && "method" in message && (message as { method: unknown }).method === "tools/call");
}

function bodyCallsTool(body: unknown): boolean {
  return Array.isArray(body) ? body.some(isToolsCall) : isToolsCall(body);
}

function jsonRpcId(body: unknown): string | number | null {
  const message = Array.isArray(body) ? body.find(isToolsCall) : body;
  if (!message || typeof message !== "object" || !("id" in message)) return null;
  const id = (message as { id: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...extra,
  });
  res.end(payload);
}

function rateLimitPerMinute(): number {
  const raw = Number(process.env.TENPRINT_RATE_LIMIT_PER_MINUTE ?? "120");
  if (!Number.isFinite(raw) || raw < 1) return 120;
  return Math.floor(raw);
}

function bucketCap(): number {
  const raw = Number(process.env.TENPRINT_RATE_BUCKET_CAP ?? "4096");
  if (!Number.isFinite(raw) || raw < 1) return 4096;
  return Math.floor(raw);
}

/** Off unless TENPRINT_TRUSTED_PROXY is 1/true/on, or a comma-separated list of proxy addresses. */
function trustedProxyEnabled(remote: string): boolean {
  const raw = (process.env.TENPRINT_TRUSTED_PROXY ?? "").trim().toLowerCase();
  if (!raw || raw === "0" || raw === "false" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "on") return true;
  return raw.split(",").map((part) => part.trim()).filter(Boolean).includes(remote);
}

function rateLimitAddress(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  if (!trustedProxyEnabled(remote)) return remote;
  const hops = headerValue(req.headers["x-forwarded-for"]).split(",").map((part) => part.trim()).filter(Boolean);
  return hops.length > 0 ? hops[hops.length - 1] : remote;
}

let rateChecks = 0;

function sweepBuckets(now: number): void {
  rateChecks += 1;
  if (rateChecks % 64 !== 0 && hits.size <= bucketCap()) return;
  for (const [key, times] of hits) {
    const recent = times.filter((at) => now - at < RATE_WINDOW_MS);
    if (recent.length === 0) hits.delete(key);
    else hits.set(key, recent);
  }
  while (hits.size > bucketCap()) {
    const oldest = hits.keys().next().value;
    if (oldest === undefined) break;
    hits.delete(oldest);
  }
}

function rememberBucket(bucket: string, recent: number[]): void {
  hits.delete(bucket);
  hits.set(bucket, recent);
  while (hits.size > bucketCap()) {
    const oldest = hits.keys().next().value;
    if (oldest === undefined || oldest === bucket) break;
    hits.delete(oldest);
  }
}

function rateLimited(bucket: string): boolean {
  const now = Date.now();
  sweepBuckets(now);
  const recent = (hits.get(bucket) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (recent.length >= rateLimitPerMinute()) {
    rememberBucket(bucket, recent);
    return true;
  }
  recent.push(now);
  rememberBucket(bucket, recent);
  return false;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        req.pause();
        fail(new HttpError(413, "payload too large"));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => fail(err));
  });
}

function headersAllowed(req: IncomingMessage, res: ServerResponse): boolean {
  if (!hostAllowed(headerValue(req.headers.host))) {
    sendJson(res, 403, { error: "forbidden host" });
    return false;
  }
  if (!originAllowed(headerValue(req.headers.origin))) {
    sendJson(res, 403, { error: "forbidden origin" });
    return false;
  }
  return true;
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, boundPort: number): Promise<void> {
  const ip = rateLimitAddress(req);
  if (rateLimited(`ip:${ip}`)) {
    sendJson(res, 429, { error: "rate limit exceeded" });
    return;
  }
  const key = requestApiKey(req);
  if (key && rateLimited(`key:${key}`)) {
    sendJson(res, 429, { error: "rate limit exceeded" });
    return;
  }
  const declaredLength = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    sendJson(res, 413, { error: "payload too large" });
    req.destroy();
    return;
  }

  let parsed: unknown;
  if (req.method === "POST") {
    const raw = await readBody(req);
    if (!raw.trim()) {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    // Request key only. A hosted TENPRINT_API_KEY / RUBRIC_API_KEY must not authorize anonymous tools/call.
    if (bodyCallsTool(parsed) && !key) {
      sendJson(res, 401, {
        jsonrpc: "2.0",
        id: jsonRpcId(parsed),
        error: {
          code: -32000,
          message: "Unauthorized",
          data: { reason: "api_key_required" },
        },
      }, { "WWW-Authenticate": 'Bearer realm="tenprint"' });
      return;
    }
  }

  const mcp = createMcpServer({ transport: "http" });
  const allowedOrigins = csvEnv("TENPRINT_ALLOWED_ORIGINS");
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: sdkAllowedHosts(boundPort),
    ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
  });
  const run = async () => {
    await mcp.connect(transport);
    try {
      await transport.handleRequest(req, res, parsed);
    } finally {
      await transport.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
    }
  };
  await runWithHttpRequest(key, run);
}

export async function startHttpServer(): Promise<void> {
  // Transport is part of this function, not process.argv. Importing and calling
  // startHttpServer disables x402 even when the process was not started with --http.
  bindProcessTransport("http");
  const walletVars = ["RUBRIC_WALLET_KEY", "TENPRINT_WALLET_KEY"].filter((name) => (process.env[name] ?? "").trim() !== "");
  if (walletVars.length > 0) {
    console.error(`[TenPrint MCP] HTTP mode ignores ${walletVars.join(", ")}. x402 paid tools are disabled and this process will not sign or pay with a server wallet.`);
  }
  if ((process.env.TENPRINT_API_KEY ?? "").trim() || (process.env.RUBRIC_API_KEY ?? "").trim()) {
    console.error("[TenPrint MCP] An API key is set in the environment. HTTP tools/call does not use it; pass Authorization: Bearer or x-api-key on the request.");
  }

  const port = listenPort();
  const host = bindHost();
  let boundPort = port;
  const httpServer = createServer((req, res) => {
    void (async () => {
      try {
        if (!headersAllowed(req, res)) return;
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        if (req.method === "OPTIONS") {
          res.writeHead(204, { Allow: "GET, POST" });
          res.end();
          return;
        }
        if (req.method === "GET" && pathname === "/health") {
          sendJson(res, 200, { status: "ok" });
          return;
        }
        if (req.method === "GET" && pathname === "/.well-known/mcp/server-card.json") {
          sendJson(res, 200, buildServerCard());
          return;
        }
        if (pathname === "/mcp" && (req.method === "GET" || req.method === "DELETE")) {
          sendJson(res, 405, { error: "method not allowed" }, { Allow: "POST" });
          return;
        }
        if (pathname === "/mcp" && req.method === "POST") {
          await handleMcp(req, res, boundPort);
          return;
        }
        sendJson(res, 404, { error: "not found" });
      } catch (err) {
        if (err instanceof HttpError && !res.headersSent) {
          sendJson(res, err.status, { error: err.message });
          req.destroy();
          return;
        }
        console.error(err);
        if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
      }
    })();
  });
  httpServer.requestTimeout = 30_000;
  httpServer.headersTimeout = 20_000;
  httpServer.timeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      const address = httpServer.address();
      if (typeof address === "object" && address) boundPort = address.port;
      resolve();
    });
  });
  console.error(`[TenPrint MCP] Streamable HTTP listening on ${host}:${boundPort} (POST /mcp)`);
}
