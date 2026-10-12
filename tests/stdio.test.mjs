import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function encode(message) {
  return `${JSON.stringify(message)}\n`;
}

function createReader(stream) {
  let buf = "";
  const waiters = [];
  const pump = () => {
    while (waiters.length > 0) {
      const newline = buf.indexOf("\n");
      if (newline === -1) return;
      const line = buf.slice(0, newline);
      buf = buf.slice(newline + 1);
      waiters.shift()(JSON.parse(line));
    }
  };
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    pump();
  });
  return () => new Promise((resolve) => {
    waiters.push(resolve);
    pump();
  });
}

function localApi() {
  const server = createServer((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"missing"}');
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test("stdio verify reads a local bundle id and ignores a path outside the store", async () => {
  const home = mkdtempSync(join(tmpdir(), "tenprint-stdio-"));
  const api = await localApi();
  const outside = join(tmpdir(), `tenprint-probe-${process.pid}.json`);
  writeFileSync(outside, JSON.stringify({ secret: "SECRET_PROBE_VALUE", attestationId: "escaped" }));
  const store = join(home, ".rubric", "local-bundles");
  mkdirSync(store, { recursive: true });
  const escapedId = relative(store, outside).replace(/\.json$/, "");

  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      HOME: home,
      RUBRIC_BASE_URL: api.url,
      TENPRINT_API_KEY: "",
      RUBRIC_API_KEY: "",
      RUBRIC_WALLET_KEY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const read = createReader(child.stdout);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const call = async (id, method, params) => {
    child.stdin.write(encode({ jsonrpc: "2.0", id, method, params }));
    return read();
  };
  try {
    const init = await call(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "stdio-test", version: "0.0.0" },
    });
    assert.equal(init.result.serverInfo.name, "TenPrint");
    const attested = await call(2, "tools/call", { name: "attest", arguments: { payload: "local leaf" } });
    assert.equal(attested.result.isError, undefined);
    const leaf = JSON.parse(attested.result.content[0].text);
    assert.match(leaf.attestationId, /^[A-Za-z0-9_-]+$/);
    const verified = await call(3, "tools/call", { name: "verify", arguments: { attestation_id: leaf.attestationId } });
    const verifiedBody = JSON.parse(verified.result.content[0].text);
    assert.equal(verifiedBody.source, "local");
    assert.equal(verifiedBody.attestationId, leaf.attestationId);

    const escaped = await call(4, "tools/call", { name: "verify", arguments: { attestation_id: escapedId } });
    const escapedText = escaped.result.content[0].text;
    assert.equal(escapedText.includes("SECRET_PROBE_VALUE"), false, escapedText);
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : err}\n${stderr}`);
  } finally {
    child.kill();
    await api.close();
  }
});

test("stdio tools/call rejects a module omitted from RUBRIC_MCP_MODULES", async () => {
  const home = mkdtempSync(join(tmpdir(), "tenprint-stdio-mod-"));
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      HOME: home,
      TENPRINT_API_KEY: "",
      RUBRIC_API_KEY: "",
      RUBRIC_WALLET_KEY: "",
      RUBRIC_MCP_MODULES: "core",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const read = createReader(child.stdout);
  const call = async (id, method, params) => {
    child.stdin.write(encode({ jsonrpc: "2.0", id, method, params }));
    return read();
  };
  try {
    await call(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "stdio-mod", version: "0.0.0" },
    });
    const denied = await call(2, "tools/call", { name: "screen_entity", arguments: { name: "example" } });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /not enabled/);
    assert.equal(JSON.stringify(denied).includes("spentTodayUsd"), false);
  } finally {
    child.kill();
  }
});
