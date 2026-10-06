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
  assert.equal(init.body.result.serverInfo.name, "TenPrint");
  assert.equal(init.body.result.serverInfo.version, "2.3.0");
  assert.equal(init.body.error, undefined);

  const listed = await mcp(port, "tools/list", {});
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.body.result.tools));
  assert.ok(listed.body.result.tools.length > 0);
  assert.ok(listed.body.result.tools.some((tool) => tool.name === "attest"));
  assert.equal(listed.body.result.tools.some((tool) => tool.name === "screen_entity"), false);
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
  assert.deepEqual(card.serverInfo, { name: "TenPrint", version: "2.3.0" });
  assert.equal(card.authentication.required, true);
  assert.match(card.authentication.description, /tools\/call/);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
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

test("HTTP tools/call with no request key is refused even when TENPRINT_API_KEY is set", async () => {
  const envPort = await freePort();
  const envChild = startServer(envPort, { TENPRINT_API_KEY: "env-key" });
  try {
    await waitForHealth(envPort, envChild);
    assert.doesNotMatch(envChild.stderrText(), /HCS-anchored/);
    const call = await mcp(envPort, "tools/call", {
      name: "cost_estimate",
      arguments: { decisions_per_day: 10 },
    });
    assert.equal(call.status, 401);
    assert.equal(call.body.result, undefined);
    assert.equal(call.body.error.code, -32000);
    assert.equal(call.body.error.message, "Unauthorized");
    assert.equal(call.body.error.data.reason, "api_key_required");
  } finally {
    envChild.kill();
  }
});

test("HTTP tools/call with no request key is refused even when RUBRIC_API_KEY is set", async () => {
  const envPort = await freePort();
  const envChild = startServer(envPort, { RUBRIC_API_KEY: "legacy-env-key" });
  try {
    await waitForHealth(envPort, envChild);
    const call = await mcp(envPort, "tools/call", {
      name: "framework_detect",
      arguments: { payload: "patient diagnosis" },
    });
    assert.equal(call.status, 401);
    assert.equal(call.body.error.data.reason, "api_key_required");
  } finally {
    envChild.kill();
  }
});

const X402_TOOLS = ["screen_entity", "wallet_record", "agent_record", "attested_inference", "hedera_fact", "verify_audit"];

test("HTTP tools/list omits x402 tools when RUBRIC_WALLET_KEY is set", async () => {
  const envPort = await freePort();
  const envChild = startServer(envPort, {
    RUBRIC_WALLET_KEY: "test-wallet-key-not-used",
    RUBRIC_MCP_MODULES: "all",
  });
  try {
    await waitForHealth(envPort, envChild);
    assert.match(envChild.stderrText(), /RUBRIC_WALLET_KEY/);
    assert.match(envChild.stderrText(), /x402 paid tools are disabled/);

    const listed = await mcp(envPort, "tools/list", {});
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const names = listed.body.result.tools.map((tool) => tool.name);
    for (const name of X402_TOOLS) assert.equal(names.includes(name), false, name);
    assert.ok(names.includes("attest"));

    const cardRes = await fetch(`http://127.0.0.1:${envPort}/.well-known/mcp/server-card.json`);
    const card = await cardRes.json();
    const cardNames = card.tools.map((tool) => tool.name);
    for (const name of X402_TOOLS) assert.equal(cardNames.includes(name), false, name);

    const call = await mcp(envPort, "tools/call", {
      name: "screen_entity",
      arguments: { name: "example" },
    }, { authorization: "Bearer request-key" });
    assert.equal(call.status, 200, JSON.stringify(call.body));
    assert.equal(call.body.result.isError, true);
    assert.match(call.body.result.content[0].text, /disabled in HTTP mode/);
    assert.equal(JSON.stringify(call.body).includes("spentTodayUsd"), false);
  } finally {
    envChild.kill();
  }
});

test("GET /mcp returns 405 in stateless mode", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`);
  assert.equal(res.status, 405);
  assert.match(res.headers.get("allow") ?? "", /POST/);
  const deleted = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "DELETE" });
  assert.equal(deleted.status, 405);
});

test("a present Origin that is not allowlisted is rejected and CORS is not wildcarded", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      origin: "https://evil.example",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("an allowlisted Origin can call tools/list", async () => {
  const envPort = await freePort();
  const envChild = startServer(envPort, { TENPRINT_ALLOWED_ORIGINS: "https://app.tenprint.ai" });
  try {
    await waitForHealth(envPort, envChild);
    const ok = await fetch(`http://127.0.0.1:${envPort}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: "https://app.tenprint.ai",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(ok.status, 200, await ok.clone().text());
    const blocked = await fetch(`http://127.0.0.1:${envPort}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: "https://other.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(blocked.status, 403);
  } finally {
    envChild.kill();
  }
});

test("tools/call rejects a module that RUBRIC_MCP_MODULES did not enable", async () => {
  const call = await mcp(port, "tools/call", {
    name: "attest_batch",
    arguments: { items: [{ data: "x", sourceId: "s", extra: "nope" }] },
  }, { authorization: "Bearer test-key" });
  assert.equal(call.status, 200, JSON.stringify(call.body));
  assert.equal(call.body.result.isError, true);
  assert.match(call.body.result.content[0].text, /not enabled/);
});

test("HTTP bodies over 1MB are rejected", async () => {
  const envPort = await freePort();
  const envChild = startServer(envPort);
  try {
    await waitForHealth(envPort, envChild);
    const res = await fetch(`http://127.0.0.1:${envPort}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: `{"pad":"${"a".repeat(1_100_000)}"}`,
    });
    assert.equal(res.status, 413);
  } finally {
    envChild.kill();
  }
});

test("HTTP rate limit returns 429", async () => {
  const envPort = await freePort();
  const envChild = startServer(envPort, { TENPRINT_RATE_LIMIT_PER_MINUTE: "2" });
  try {
    await waitForHealth(envPort, envChild);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const first = await fetch(`http://127.0.0.1:${envPort}/mcp`, { method: "POST", headers, body });
    const second = await fetch(`http://127.0.0.1:${envPort}/mcp`, { method: "POST", headers, body });
    const third = await fetch(`http://127.0.0.1:${envPort}/mcp`, { method: "POST", headers, body });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
  } finally {
    envChild.kill();
  }
});

test("importing startHttpServer without --http does not serve x402 tools", async () => {
  const envPort = await freePort();
  const embed = join(dirname(fileURLToPath(import.meta.url)), "embed-http.mjs");
  const envChild = spawn(process.execPath, [embed], {
    env: {
      ...process.env,
      PORT: String(envPort),
      HOST: "127.0.0.1",
      TENPRINT_API_KEY: "",
      RUBRIC_API_KEY: "",
      RUBRIC_WALLET_KEY: "test-wallet-key-not-used",
      RUBRIC_MCP_MODULES: "all",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  envChild.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  envChild.stderrText = () => stderr;
  try {
    await waitForHealth(envPort, envChild);
    assert.doesNotMatch(stderr, /HCS-anchored/);
    assert.match(stderr, /x402 paid tools are disabled/);
    const listed = await mcp(envPort, "tools/list", {});
    const names = listed.body.result.tools.map((tool) => tool.name);
    for (const name of X402_TOOLS) assert.equal(names.includes(name), false, name);
    const call = await mcp(envPort, "tools/call", {
      name: "screen_entity",
      arguments: { name: "example" },
    }, { authorization: "Bearer request-key" });
    assert.equal(call.body.result.isError, true);
    assert.match(call.body.result.content[0].text, /disabled in HTTP mode/);
  } finally {
    envChild.kill();
  }
});
