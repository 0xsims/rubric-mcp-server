import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runner = join(dirname(fileURLToPath(import.meta.url)), "embed-default-runner.mjs");
const HOST_KEY = "host-secret-should-not-leak";

function startApi() {
  const seen = [];
  const server = createServer((req, res) => {
    const paid = req.headers["payment-signature"] || req.headers["x-payment"];
    seen.push({
      url: req.url ?? "",
      apiKey: typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : "",
      paid: Boolean(paid),
    });
    if (paid) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if ((req.url ?? "").includes("/v1/x402/")) {
      const body = {
        x402Version: 2,
        resource: { url: `http://127.0.0.1${req.url}`, description: "test", mimeType: "application/json" },
        accepts: [{
          scheme: "exact",
          network: "eip155:8453",
          amount: "1000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0xaB6731A0BcDf511c2842C768a03448075aB654ca",
          maxTimeoutSeconds: 60,
          extra: { name: "USD Coin", version: "2" },
        }],
      };
      res.writeHead(402, {
        "content-type": "application/json",
        "payment-required": Buffer.from(JSON.stringify(body)).toString("base64"),
      });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen: () => seen,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test("embedded createMcpServer() does not sign or forward the host API key", async () => {
  const api = await startApi();
  const home = mkdtempSync(join(tmpdir(), "tenprint-embed-"));
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [runner], {
        env: {
          ...process.env,
          HOME: home,
          RUBRIC_BASE_URL: api.url,
          TENPRINT_API_KEY: HOST_KEY,
          RUBRIC_API_KEY: "",
          RUBRIC_WALLET_KEY: `0x${randomBytes(32).toString("hex")}`,
          RUBRIC_MCP_MODULES: "all",
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`embed runner exited ${code}\n${stderr}\n${stdout}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (err) {
          reject(new Error(`bad embed output ${stdout}\n${stderr}\n${err}`));
        }
      });
    });

    assert.equal(result.embeddedTools.includes("screen_entity"), false);
    assert.equal(result.optedTools.includes("screen_entity"), true);
    assert.equal(result.screen.isError, true);
    assert.match(result.screen.content[0].text, /disabled in HTTP mode/);

    const embeddedStatus = JSON.parse(result.embeddedStatus.content[0].text);
    assert.equal(embeddedStatus.ok, true);
    assert.equal(result.embeddedStatus.isError, undefined);
    const optedStatus = JSON.parse(result.optedStatus.content[0].text);
    assert.equal(optedStatus.ok, true);

    const seen = api.seen();
    assert.equal(seen.some((hit) => hit.paid), false, JSON.stringify(seen));
    assert.equal(seen.some((hit) => hit.url.includes("/v1/x402/")), false, JSON.stringify(seen));
    assert.deepEqual(seen.map((hit) => hit.apiKey), ["", HOST_KEY], JSON.stringify(seen));
    assert.equal(seen.filter((hit) => hit.apiKey === HOST_KEY).length, 1);
  } finally {
    await api.close();
  }
});
