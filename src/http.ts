import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, listEnabledTools, packageVersion, runWithApiKey, SERVER_NAME } from "./index.js";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, x-api-key, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
};

export function buildServerCard() {
  return {
    serverInfo: { name: SERVER_NAME, version: packageVersion() },
    authentication: { required: false, schemes: ["bearer"] },
    tools: listEnabledTools(),
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

function headerValue(value: string | string[] | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return "";
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
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...CORS, ...extra });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    if (bodyCallsTool(parsed) && !requestApiKey(req)) {
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

  const mcp = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const key = requestApiKey(req);
  const run = async () => {
    await mcp.connect(transport);
    try {
      await transport.handleRequest(req, res, parsed);
    } finally {
      await transport.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
    }
  };
  if (key) await runWithApiKey(key, run);
  else await run();
}

export async function startHttpServer(): Promise<void> {
  const port = listenPort();
  const httpServer = createServer((req, res) => {
    void (async () => {
      try {
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        if (req.method === "OPTIONS") {
          res.writeHead(204, CORS);
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
        if (pathname === "/mcp" && (req.method === "POST" || req.method === "GET" || req.method === "DELETE")) {
          await handleMcp(req, res);
          return;
        }
        sendJson(res, 404, { error: "not found" });
      } catch (err) {
        console.error(err);
        if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "0.0.0.0", () => resolve());
  });
  const address = httpServer.address();
  const bound = typeof address === "object" && address ? address.port : port;
  console.error(`[TenPrint MCP] Streamable HTTP listening on :${bound} (POST /mcp)`);
}
