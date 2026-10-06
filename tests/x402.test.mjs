import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runner = join(dirname(fileURLToPath(import.meta.url)), "x402-runner.mjs");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYTO = "0xaB6731A0BcDf511c2842C768a03448075aB654ca";

function requirements(amount, overrides = {}) {
  return {
    x402Version: 2,
    resource: { url: "http://127.0.0.1/paid", description: "test", mimeType: "application/json" },
    accepts: [{
      scheme: "exact",
      network: "eip155:8453",
      amount: String(amount),
      asset: USDC,
      payTo: PAYTO,
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2" },
      ...overrides,
    }],
  };
}

function paymentRequiredHeader(body) {
  return Buffer.from(JSON.stringify(body)).toString("base64");
}

function startPaid({ amount, paidStatus, overrides = {}, delayMs = 0 }) {
  let signed = 0;
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    const paid = req.headers["payment-signature"] || req.headers["x-payment"];
    const finish = () => {
      if (paid) {
        signed += 1;
        res.writeHead(paidStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: paidStatus === 200 }));
        return;
      }
      const host = req.headers.host;
      const body = requirements(amount, overrides);
      body.resource.url = `http://${host}${req.url}`;
      res.writeHead(402, {
        "content-type": "application/json",
        "payment-required": paymentRequiredHeader(body),
      });
      res.end(JSON.stringify(body));
    };
    if (delayMs > 0) setTimeout(finish, delayMs);
    else finish();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        signed: () => signed,
        requests: () => requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function run(env, input) {
  const home = mkdtempSync(join(tmpdir(), "tenprint-x402-"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, JSON.stringify(input)], {
      env: {
        ...process.env,
        HOME: home,
        RUBRIC_WALLET_KEY: `0x${randomBytes(32).toString("hex")}`,
        RUBRIC_X402_CONFIRM: "",
        TENPRINT_API_KEY: "",
        RUBRIC_API_KEY: "",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`x402 runner exited ${code}\n${stderr}\n${stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`bad runner output ${stdout}\n${stderr}\n${err}`));
      }
    });
  });
}

test("x402 refuses to sign when the 402 price is above the tool maximum", async () => {
  const paid = await startPaid({ amount: 500_000, paidStatus: 200 });
  try {
    const result = await run({
      RUBRIC_BASE_URL: paid.url,
      RUBRIC_X402_DAILY_LIMIT: "1.00",
    }, { name: "hedera_fact", args: { fact: "exchange-rate" } });
    assert.equal(paid.signed(), 0);
    assert.equal(result.error, "PRICE_ABOVE_TOOL_MAX");
    assert.equal(result.toolMaxUsd, 0.001);
    assert.equal(result.httpStatus, undefined);
  } finally {
    await paid.close();
  }
});

test("parallel x402 calls cannot pass the daily limit", async () => {
  const paid = await startPaid({ amount: 10_000, paidStatus: 200, delayMs: 40 });
  try {
    const calls = Array.from({ length: 10 }, () => ({ name: "screen_entity", args: { name: "example" } }));
    const results = await run({
      RUBRIC_BASE_URL: paid.url,
      RUBRIC_X402_DAILY_LIMIT: "0.03",
    }, { parallel: true, calls });
    const paidResults = results.filter((result) => result.httpStatus === 200);
    const blocked = results.filter((result) => result.error === "DAILY_BUDGET_EXCEEDED");
    assert.equal(paidResults.length, 3, JSON.stringify(results));
    assert.equal(blocked.length, 7);
    assert.equal(paid.signed(), 3);
    for (const result of results) assert.ok(result.spentTodayUsd <= 0.03, JSON.stringify(result));
  } finally {
    await paid.close();
  }
});

test("a non-200 response still counts toward x402 spend", async () => {
  const paid = await startPaid({ amount: 1_000, paidStatus: 500 });
  try {
    const result = await run({
      RUBRIC_BASE_URL: paid.url,
      RUBRIC_X402_DAILY_LIMIT: "1.00",
    }, { name: "hedera_fact", args: { fact: "supply" } });
    assert.equal(paid.signed(), 1);
    assert.equal(result.httpStatus, 500);
    assert.equal(result.spentTodayUsd, 0.001);
  } finally {
    await paid.close();
  }
});

test("RUBRIC_X402_CONFIRM quote is bound to the same tool, arguments, and price, and is single use", async () => {
  const paid = await startPaid({ amount: 1_000, paidStatus: 200 });
  try {
    const [quote, wrongTool, requoted, wrongArgs, fresh, confirmed, reused] = await run({
      RUBRIC_BASE_URL: paid.url,
      RUBRIC_X402_DAILY_LIMIT: "1.00",
      RUBRIC_X402_CONFIRM: "1",
    }, {
      sequence: [
        { name: "hedera_fact", args: { fact: "nodes" } },
        { name: "screen_entity", args: { name: "example", confirm: true, quote_id: "$quote" } },
        { name: "hedera_fact", args: { fact: "nodes" } },
        { name: "hedera_fact", args: { fact: "supply", confirm: true, quote_id: "$quote" } },
        { name: "hedera_fact", args: { fact: "nodes" } },
        { name: "hedera_fact", args: { fact: "nodes", confirm: true, quote_id: "$quote" } },
        { name: "hedera_fact", args: { fact: "nodes", confirm: true, quote_id: "$quote" } },
      ],
    });
    assert.equal(quote.confirmationRequired, true);
    assert.equal(quote.maxPriceUsd, 0.001);
    assert.equal(quote.tool, "hedera_fact");
    assert.equal(quote.network, "eip155:8453");
    assert.equal(typeof quote.quoteId, "string");
    assert.equal(quote.quoteId.length > 0, true);
    assert.equal(wrongTool.error, "CONFIRMATION_INVALID");
    assert.equal(requoted.confirmationRequired, true);
    assert.notEqual(requoted.quoteId, quote.quoteId);
    assert.equal(wrongArgs.error, "CONFIRMATION_INVALID");
    assert.equal(fresh.confirmationRequired, true);
    assert.notEqual(fresh.quoteId, requoted.quoteId);
    assert.equal(confirmed.httpStatus, 200, JSON.stringify(confirmed));
    assert.equal(confirmed.spentTodayUsd, 0.001);
    assert.equal(reused.error, "CONFIRMATION_INVALID");
    assert.equal(paid.signed(), 1);
    assert.equal(paid.requests(), 2);
  } finally {
    await paid.close();
  }
});

test("RUBRIC_X402_CONFIRM quote expires and a confirm with no quote does not pay", async () => {
  const paid = await startPaid({ amount: 1_000, paidStatus: 200 });
  try {
    const [quote, expired] = await run({
      RUBRIC_BASE_URL: paid.url,
      RUBRIC_X402_DAILY_LIMIT: "1.00",
      RUBRIC_X402_CONFIRM: "1",
      RUBRIC_X402_CONFIRM_TTL_MS: "200",
    }, {
      sequence: [
        { name: "hedera_fact", args: { fact: "nodes" } },
        { delayMs: 400, name: "hedera_fact", args: { fact: "nodes", confirm: true, quote_id: "$quote" } },
      ],
    });
    assert.equal(quote.confirmationRequired, true);
    assert.equal(expired.error, "CONFIRMATION_INVALID");

    const missing = await run({
      RUBRIC_BASE_URL: paid.url,
      RUBRIC_X402_DAILY_LIMIT: "1.00",
      RUBRIC_X402_CONFIRM: "1",
    }, { name: "hedera_fact", args: { fact: "nodes", confirm: true } });
    assert.equal(missing.error, "CONFIRMATION_INVALID");
    assert.equal(paid.signed(), 0);
    assert.equal(paid.requests(), 0);
  } finally {
    await paid.close();
  }
});

test("an empty RUBRIC_X402_DAILY_LIMIT uses the default limit", async () => {
  const paid = await startPaid({ amount: 1_000, paidStatus: 200 });
  try {
    const result = await run({
      RUBRIC_BASE_URL: paid.url,
      RUBRIC_X402_DAILY_LIMIT: "",
    }, { name: "hedera_fact", args: { fact: "supply" } });
    assert.equal(paid.signed(), 1);
    assert.equal(result.httpStatus, 200, JSON.stringify(result));
    assert.equal(result.error, undefined);
    assert.equal(result.spentTodayUsd, 0.001);
    assert.equal(result.dailyLimitUsd, 0.25);
  } finally {
    await paid.close();
  }
});

test("confirm mode checks the server requirements against the quoted price", async () => {
  const permit2 = await startPaid({
    amount: 1_000,
    paidStatus: 200,
    overrides: { extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" } },
  });
  const overQuote = await startPaid({ amount: 2_000, paidStatus: 200 });
  try {
    const [quoted, rejected] = await run({
      RUBRIC_BASE_URL: permit2.url,
      RUBRIC_X402_DAILY_LIMIT: "1.00",
      RUBRIC_X402_CONFIRM: "1",
    }, {
      sequence: [
        { name: "hedera_fact", args: { fact: "nodes" } },
        { name: "hedera_fact", args: { fact: "nodes", confirm: true, quote_id: "$quote" } },
      ],
    });
    assert.equal(quoted.confirmationRequired, true);
    assert.equal(quoted.maxPriceUsd, 0.001);
    assert.equal(rejected.error, "PAYMENT_REQUIREMENTS_REJECTED");
    assert.equal(permit2.signed(), 0);

    const [again, tooHigh] = await run({
      RUBRIC_BASE_URL: overQuote.url,
      RUBRIC_X402_DAILY_LIMIT: "1.00",
      RUBRIC_X402_CONFIRM: "1",
    }, {
      sequence: [
        { name: "hedera_fact", args: { fact: "nodes" } },
        { name: "hedera_fact", args: { fact: "nodes", confirm: true, quote_id: "$quote" } },
      ],
    });
    assert.equal(again.confirmationRequired, true);
    assert.equal(tooHigh.error, "PRICE_ABOVE_TOOL_MAX");
    assert.equal(tooHigh.toolMaxUsd, 0.001);
    assert.equal(overQuote.signed(), 0);
  } finally {
    await permit2.close();
    await overQuote.close();
  }
});

test("an upstream error with no payment signed does not reserve spend", async () => {
  let signed = 0;
  const server = createServer((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "upstream failed" }));
  });
  const paid = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
  server.on("request", (req) => {
    if (req.headers["payment-signature"] || req.headers["x-payment"]) signed += 1;
  });
  try {
    const result = await run({
      RUBRIC_BASE_URL: paid.url,
      RUBRIC_X402_DAILY_LIMIT: "0.25",
    }, { name: "hedera_fact", args: { fact: "supply" } });
    assert.equal(signed, 0);
    assert.equal(result.httpStatus, 500, JSON.stringify(result));
    assert.equal(result.spentTodayUsd, 0);
    assert.equal(result.error, "upstream failed");
  } finally {
    await paid.close();
  }
});
