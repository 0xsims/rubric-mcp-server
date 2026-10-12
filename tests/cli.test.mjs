import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function encode(message) {
  return `${JSON.stringify(message)}\n`;
}

function readMessage(stream) {
  let buf = "";
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buf += chunk.toString();
      const newline = buf.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      try {
        resolve(JSON.parse(buf.slice(0, newline)));
      } catch (err) {
        reject(err);
      }
    };
    const cleanup = () => stream.off("data", onData);
    stream.on("data", onData);
  });
}

test("the bin stays up when argv is a symlink, as npm global and npx install it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tenprint-bin-"));
  const link = join(dir, "tenprint-mcp");
  symlinkSync(entry, link);
  const child = spawn(process.execPath, [link], {
    env: { ...process.env, TENPRINT_API_KEY: "", RUBRIC_API_KEY: "", RUBRIC_WALLET_KEY: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const response = readMessage(child.stdout);
  child.stdin.write(encode({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "symlink-test", version: "0.0.0" },
    },
  }));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const result = await Promise.race([
    response,
    exited.then((code) => {
      throw new Error(`symlink bin exited ${code} before initialize: ${stderr}`);
    }),
  ]);
  assert.equal(result.result.serverInfo.name, "TenPrint");
  child.kill();
});
