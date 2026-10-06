import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function startServer(port, env) {
  const child = spawn(process.execPath, [entry, "--http"], {
    env: {
      ...process.env,
      PORT: String(port),
      TENPRINT_API_KEY: "",
      RUBRIC_API_KEY: "",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });
  child.stderrText = () => stderr;
  return child;
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 10000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${child.stderrText()}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become healthy: ${lastError ?? ""} ${child.stderrText()}`);
}

async function mcp(port, method, params, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const initParams = {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "tenprint-http-test", version: "0.0.0" },
};

let child;
let port;

before(async () => {
  port = await freePort();
  child = startServer(port);
  await waitForHealth(port, child);
});

after(() => {
  child?.kill();
});

test("unauthenticated initialize and tools/list succeed", async () => {
  const init = await mcp(port, "initialize", initParams);
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, "Tenprint");
  assert.equal(init.body.result.serverInfo.version, "2.3.0");
  assert.equal(init.body.error, undefined);

  const listed = await mcp(port, "tools/list", {});
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.body.result.tools));
  assert.ok(listed.body.result.tools.length > 0);
  assert.ok(listed.body.result.tools.some((tool) => tool.name === "attest"));
  assert.ok(listed.body.result.tools.some((tool) => tool.name === "screen_entity"));
});

test("unauthenticated tools/call is refused", async () => {
  const call = await mcp(port, "tools/call", {
    name: "framework_detect",
    arguments: { payload: "patient diagnosis" },
  });
  assert.equal(call.status, 401);
  assert.equal(call.body.result, undefined);
  assert.equal(call.body.error.code, -32000);
  assert.equal(call.body.error.message, "Unauthorized");
  assert.equal(call.body.error.data.reason, "api_key_required");
  assert.match(call.body.error.message, /Unauthorized/);
});

test("server card tools match tools/list", async () => {
  const listed = await mcp(port, "tools/list", {});
  const res = await fetch(`http://127.0.0.1:${port}/.well-known/mcp/server-card.json`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const card = await res.json();
  assert.deepEqual(card.serverInfo, { name: "Tenprint", version: "2.3.0" });
  assert.deepEqual(card.tools, listed.body.result.tools);
  assert.deepEqual(card.resources, []);
  assert.deepEqual(card.prompts, []);
});

test("Authorization bearer and x-api-key allow tools/call", async () => {
  const args = { name: "framework_detect", arguments: { payload: "hiring a candidate" } };
  const bearer = await mcp(port, "tools/call", args, { authorization: "Bearer test-key" });
  assert.equal(bearer.status, 200, JSON.stringify(bearer.body));
  assert.equal(bearer.body.error, undefined);
  const bearerPayload = JSON.parse(bearer.body.result.content[0].text);
  assert.ok(bearerPayload.frameworks.includes("NYC_LL144"));

  const header = await mcp(port, "tools/call", args, { "x-api-key": "test-key" });
  assert.equal(header.status, 200, JSON.stringify(header.body));
  assert.equal(header.body.error, undefined);
});

test("TENPRINT_API_KEY in the environment allows tools/call without a request header", async () => {
  const envPort = await freePort();
  const envChild = startServer(envPort, { TENPRINT_API_KEY: "env-key" });
  try {
    await waitForHealth(envPort, envChild);
    const call = await mcp(envPort, "tools/call", {
      name: "cost_estimate",
      arguments: { decisions_per_day: 10 },
    });
    assert.equal(call.status, 200, JSON.stringify(call.body));
    const payload = JSON.parse(call.body.result.content[0].text);
    assert.equal(payload.tier, "Standard");
  } finally {
    envChild.kill();
  }
});
