import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scenarioPath = fileURLToPath(new URL("./x402-scenario.mjs", import.meta.url));
const workerPath = fileURLToPath(new URL("./x402-race-worker.mjs", import.meta.url));
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const {
  parseDailyLimitMicro,
  usdToMicroCeil,
  fetchWithTimeout,
  DEFAULT_DAILY_LIMIT_MICRO,
} = await import("../dist/x402-spend.js");

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
  assert.equal(r.spentMicro, null);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].error, "PRICE_ABOVE_TOOL_MAX");
  assert.equal(r.results[0].toolMaxUsd, 0.001);
});

test("parallel daily-limit race cannot exceed the limit", async () => {
  const r = await run("daily-race");
  assert.equal(r.signedCount, 3);
  assert.deepEqual(r.signedValues, ["10000", "10000", "10000"]);
  assert.equal(r.spentMicro, 30000);
  const paid = r.results.filter((x) => x.httpStatus === 200);
  const blocked = r.results.filter((x) => x.error === "DAILY_BUDGET_EXCEEDED");
  assert.equal(paid.length, 3);
  assert.equal(blocked.length, 7);
  assert.ok(r.signedValues.every((v) => Number(v) === 10000));
});

test("a non-200 response still counts toward spend", async () => {
  const r = await run("non-200");
  assert.equal(r.signedCount, 1);
  assert.deepEqual(r.signedValues, ["1000"]);
  assert.equal(r.results[0].httpStatus, 500);
  assert.equal(Math.round(r.results[0].spentTodayUsd * 1e6), 1000);
  assert.equal(r.spentMicro, 1000);
  assert.equal(r.results[1].error, "DAILY_BUDGET_EXCEEDED");
  assert.equal(Math.round(r.results[1].spentTodayUsd * 1e6), 1000);
});

test("wrong network, asset, or payTo is refused before signing", async () => {
  for (const name of ["wrong-network", "wrong-asset", "wrong-payto"]) {
    const r = await run(name);
    assert.equal(r.signedCount, 0, name);
    assert.equal(r.spentMicro, null, name);
    assert.equal(r.results[0].error, "PAYMENT_REQUIREMENTS_REJECTED", name);
  }
});

test("a pinned Base USDC payment at the tool max is signed", async () => {
  const r = await run("pinned-ok");
  assert.equal(r.signedCount, 1);
  assert.deepEqual(r.signedValues, ["1000"]);
  assert.equal(r.results[0].httpStatus, 200);
  assert.equal(r.spentMicro, 1000);
  assert.equal(r.modes.dir, 0o700);
  assert.equal(r.modes.file, 0o600);
  assert.equal(r.modes.fileIsSymlink, false);
});

test("S1 invalid daily limits fall back to $0.25 and empty means unset", () => {
  assert.equal(parseDailyLimitMicro(undefined), DEFAULT_DAILY_LIMIT_MICRO);
  assert.equal(parseDailyLimitMicro(""), DEFAULT_DAILY_LIMIT_MICRO);
  assert.equal(parseDailyLimitMicro("   "), DEFAULT_DAILY_LIMIT_MICRO);
  for (const raw of ["abc", "Infinity", "1,00", "$0.002", "0", "-1", "1e2"]) {
    assert.equal(parseDailyLimitMicro(raw), 250_000, raw);
  }
  assert.equal(parseDailyLimitMicro("0.25"), 250_000);
  assert.equal(parseDailyLimitMicro("1.00"), 1_000_000);
  assert.equal(parseDailyLimitMicro("0.50"), 500_000);
});

test("S1 an invalid limit uses $0.25, not unlimited and not $1", async () => {
  const seeded = await run("limit-invalid-seeded");
  assert.equal(seeded.signedCount, 0);
  assert.equal(seeded.results[0].error, "DAILY_BUDGET_EXCEEDED");
  assert.equal(seeded.spentMicro, 250000);
  assert.equal(seeded.results[0].dailyLimitUsd, 0.25);

  const empty = await run("limit-invalid-empty");
  assert.equal(empty.signedCount, 1);
  assert.equal(empty.spentMicro, 1000);

  const explicit = await run("limit-explicit");
  assert.equal(explicit.signedCount, 1);
  assert.equal(explicit.spentMicro, 251000);
});

test("S2 a corrupt, wrong-type, negative, or future ledger refuses payment", async () => {
  for (const name of ["ledger-corrupt", "ledger-string", "ledger-negative", "ledger-negative-usd", "ledger-future"]) {
    const r = await run(name);
    assert.equal(r.signedCount, 0, name);
    assert.equal(r.results[0].error, "LEDGER_INVALID", name);
    assert.equal(r.ledgerText, r.planted, name);
  }
});

test("S2 a valid earlier day resets and a payment can proceed", async () => {
  const r = await run("ledger-earlier-day");
  assert.equal(r.signedCount, 1);
  assert.equal(r.spentMicro, 1000);
  const parsed = JSON.parse(r.ledgerText);
  assert.equal(parsed.date, new Date().toISOString().slice(0, 10));
  assert.equal("spentUsd" in parsed, false);
});

test("S5 permit2, a long validity window, a zero amount, and a wrong domain are refused before signing", async () => {
  for (const name of ["permit2", "long-validity", "zero-amount", "leading-zeros", "wrong-domain"]) {
    const r = await run(name);
    assert.equal(r.signedCount, 0, name);
    assert.equal(r.spentMicro, null, name);
    assert.equal(r.results[0].error, "PAYMENT_REQUIREMENTS_REJECTED", name);
  }
});

test("S4 fetchWithTimeout aborts a hung request", async () => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const started = Date.now();
  try {
    await fetchWithTimeout(fetch, 300)(`http://127.0.0.1:${port}/hang`);
    assert.fail("expected a timeout");
  } catch (err) {
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `elapsed ${elapsed}`);
    assert.ok(elapsed >= 250, `elapsed ${elapsed}`);
    assert.equal(err.name, "TimeoutError");
    assert.match(String(err.message), /timed out after 300ms/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("S4 a hung paid call does not block another tool", async () => {
  const r = await run("head-of-line");
  assert.ok(r.elapsedMs < 2000, `wallet_record waited ${r.elapsedMs}ms`);
  assert.equal(r.signedCount, 1);
  assert.equal(r.results[0].httpStatus, 200);
  assert.equal(r.spentMicro, 1000);
});

test("a symlinked ledger is refused and its target is left untouched", async () => {
  const r = await run("symlink");
  assert.equal(r.signedCount, 0);
  assert.equal(r.results[0].error, "LEDGER_SYMLINK");
  assert.equal(r.targetText, "DO-NOT-TOUCH");
  assert.equal(r.modes.fileIsSymlink, true);
});

test("a legacy spentUsd ledger is read rounded up and rewritten as spentMicro", async () => {
  assert.equal(usdToMicroCeil(0.03), 30000);
  assert.equal(usdToMicroCeil(0.0010004), 1001);
  const r = await run("legacy-usd");
  assert.equal(r.signedCount, 1);
  assert.equal(r.spentMicro, 2001);
  const parsed = JSON.parse(r.ledgerText);
  assert.deepEqual(parsed, { date: new Date().toISOString().slice(0, 10), spentMicro: 2001 });
});

test("four processes cannot exceed the shared daily limit", async () => {
  const home = mkdtempSync(join(tmpdir(), "x402-race-"));
  const signed = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const sig = req.headers["payment-signature"] || req.headers["x-payment"];
      if (sig) {
        const payload = JSON.parse(Buffer.from(String(sig), "base64").toString("utf8"));
        signed.push(String(payload?.payload?.authorization?.value ?? ""));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const body = {
        x402Version: 2,
        error: "PAYMENT-SIGNATURE header is required",
        resource: { url: "http://127.0.0.1/paid", description: "test", mimeType: "application/json" },
        accepts: [{
          scheme: "exact",
          network: "eip155:8453",
          amount: "1000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0xaB6731A0BcDf511c2842C768a03448075aB654ca",
          maxTimeoutSeconds: 120,
          extra: { name: "USD Coin", version: "2" },
        }],
      };
      res.writeHead(402, {
        "content-type": "application/json",
        "payment-required": Buffer.from(JSON.stringify(body)).toString("base64"),
      });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const goFile = join(home, "go");
  const children = [];
  try {
    for (let i = 0; i < 4; i++) {
      const ready = join(home, `ready-${i}`);
      const child = spawn(process.execPath, [workerPath], {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          RUBRIC_WALLET_KEY: KEY,
          RUBRIC_BASE_URL: url,
          RUBRIC_X402_DAILY_LIMIT: "0.005",
          READY_FILE: ready,
          GO_FILE: goFile,
          CALLS: "4",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      children.push({ child, ready, get out() { return out; }, get err() { return err; } });
    }
    const readyDeadline = Date.now() + 30_000;
    while (children.some((c) => !exists(c.ready))) {
      if (Date.now() > readyDeadline) throw new Error("workers did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    writeFileSync(goFile, "1");
    const codes = await Promise.all(children.map((c) => new Promise((resolve) => c.child.on("close", resolve))));
    for (let i = 0; i < children.length; i++) {
      assert.equal(codes[i], 0, children[i].err + children[i].out);
    }
    assert.equal(signed.length, 5);
    assert.ok(signed.every((v) => v === "1000"));
    const ledger = JSON.parse(readFileSync(join(home, ".rubric", "x402-spend.json"), "utf8"));
    assert.equal(ledger.spentMicro, 5000);
  } finally {
    server.closeAllConnections();
    server.close();
    for (const c of children) c.child.kill();
  }
});

function exists(path) {
  try { statSync(path); return true; } catch { return false; }
}
