import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scenarioPath = fileURLToPath(new URL("./x402-scenario.mjs", import.meta.url));
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function micros(usd) {
  return Math.round(Number(usd) * 1e6);
}

function run(name) {
  const home = mkdtempSync(join(tmpdir(), "x402-"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scenarioPath, name], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        RUBRIC_WALLET_KEY: KEY,
        RUBRIC_BASE_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`scenario ${name} exited ${code}\n${out}\n${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`bad json from ${name}: ${out}\n${err}\n${e}`));
      }
    });
  });
}

test("over-price payment requirements are refused before signing", async () => {
  const r = await run("over-price");
  assert.equal(r.signedCount, 0);
  assert.equal(r.spentUsd, null);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].error, "PRICE_ABOVE_TOOL_MAX");
  assert.equal(r.results[0].toolMaxUsd, 0.001);
});

test("parallel daily-limit race cannot exceed the limit", async () => {
  const r = await run("daily-race");
  assert.equal(r.signedCount, 3);
  assert.deepEqual(r.signedValues, ["10000", "10000", "10000"]);
  assert.equal(micros(r.spentUsd), 30000);
  const paid = r.results.filter((x) => x.httpStatus === 200);
  const blocked = r.results.filter((x) => x.error === "DAILY_BUDGET_EXCEEDED");
  assert.equal(paid.length, 3);
  assert.equal(blocked.length, 7);
  assert.ok(r.signedValues.every((v) => micros(Number(v) / 1e6) === 10000));
});

test("a non-200 response still counts toward spend", async () => {
  const r = await run("non-200");
  assert.equal(r.signedCount, 1);
  assert.deepEqual(r.signedValues, ["1000"]);
  assert.equal(r.results[0].httpStatus, 500);
  assert.equal(micros(r.results[0].spentTodayUsd), 1000);
  assert.equal(micros(r.spentUsd), 1000);
  assert.equal(r.results[1].error, "DAILY_BUDGET_EXCEEDED");
  assert.equal(micros(r.results[1].spentTodayUsd), 1000);
});

test("wrong network, asset, or payTo is refused before signing", async () => {
  for (const name of ["wrong-network", "wrong-asset", "wrong-payto"]) {
    const r = await run(name);
    assert.equal(r.signedCount, 0, name);
    assert.equal(r.spentUsd, null, name);
    assert.equal(r.results[0].error, "PAYMENT_REQUIREMENTS_REJECTED", name);
  }
});

test("a pinned Base USDC payment at the tool max is signed", async () => {
  const r = await run("pinned-ok");
  assert.equal(r.signedCount, 1);
  assert.deepEqual(r.signedValues, ["1000"]);
  assert.equal(r.results[0].httpStatus, 200);
  assert.equal(micros(r.spentUsd), 1000);
});
