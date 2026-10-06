// Mock x402 upstream. No real payments, no broadcast.
import http from "node:http";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYTO = "0xaB6731A0BcDf511c2842C768a03448075aB654ca";
const SPEND_DIR = join(homedir(), ".rubric");
const SPEND_FILE = join(SPEND_DIR, "x402-spend.json");

function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

function accept(overrides) {
  return {
    scheme: "exact",
    network: "eip155:8453",
    amount: "1000",
    asset: USDC,
    payTo: PAYTO,
    maxTimeoutSeconds: 120,
    extra: { name: "USD Coin", version: "2" },
    ...overrides,
  };
}

// Live catalog also offers non-Base accepts. A correct client must ignore them.
const OTHER_CHAINS = [
  accept({
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    amount: "1000",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    payTo: "GBfJMhGiGJeWDcve1G673hEp8DLmMFomvSEHMzRfmcJu",
    extra: { feePayer: "BFK9TLC3edb13K6v4YyH3DwPb5DSUpkWvb7XnqCL9b4F" },
  }),
];

function paymentRequired(accepts) {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: "http://127.0.0.1/paid",
      description: "test",
      mimeType: "application/json",
    },
    accepts,
  };
}

function signedValue(header) {
  const payload = JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
  return String(payload?.payload?.authorization?.value ?? "");
}

function readLedger() {
  try {
    const text = readFileSync(SPEND_FILE, "utf8");
    let spentMicro = null;
    try {
      const s = JSON.parse(text);
      if (typeof s.spentMicro === "number") spentMicro = s.spentMicro;
    } catch { /* corrupt ledger stays unparsed */ }
    return { spentMicro, ledgerText: text };
  } catch {
    return { spentMicro: null, ledgerText: null };
  }
}

function modes() {
  try {
    const dir = lstatSync(SPEND_DIR);
    const file = lstatSync(SPEND_FILE);
    return {
      dir: dir.mode & 0o777,
      file: file.mode & 0o777,
      fileIsSymlink: file.isSymbolicLink(),
    };
  } catch {
    return null;
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function plant(text) {
  mkdirSync(SPEND_DIR, { recursive: true });
  writeFileSync(SPEND_FILE, text);
}

function startServer(spec) {
  const signed = [];
  let hung = 0;
  const server = http.createServer((req, res) => {
    if (spec.hangPaths && spec.hangPaths.some((part) => req.url.includes(part))) {
      hung += 1;
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const sig = req.headers["payment-signature"] || req.headers["x-payment"];
      if (sig) {
        signed.push(signedValue(sig));
        const status = spec.status();
        const body = status === 200 ? { ok: true, attestationId: "test" } : { error: "upstream failed" };
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      const headerBody = paymentRequired(spec.header());
      const jsonBody = paymentRequired(spec.body ? spec.body() : spec.header());
      res.writeHead(402, {
        "content-type": "application/json",
        "payment-required": b64(headerBody),
      });
      res.end(JSON.stringify(jsonBody));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        signed,
        url: `http://127.0.0.1:${addr.port}`,
        hung: () => hung,
      });
    });
  });
}

const challenges = {
  "over-price": {
    header: () => [accept({ amount: "500000" })],
    body: () => [accept({ amount: "1000" })],
    status: () => 200,
    limit: "1.00",
    calls: () => [{ tool: "hedera_fact", args: { fact: "exchange-rate" } }],
  },
  "daily-race": {
    header: () => [accept({ amount: "10000" }), ...OTHER_CHAINS],
    status: () => 200,
    limit: "0.03",
    calls: () => Array.from({ length: 10 }, () => ({ tool: "screen_entity", args: { name: "Example Entity" } })),
    parallel: true,
  },
  "non-200": {
    header: () => [accept({ amount: "1000" }), ...OTHER_CHAINS],
    status: () => 500,
    limit: "0.001",
    calls: () => [
      { tool: "hedera_fact", args: { fact: "supply" } },
      { tool: "hedera_fact", args: { fact: "supply" } },
    ],
  },
  "wrong-network": {
    header: () => [accept({ network: "eip155:1", amount: "1000" })],
    status: () => 200,
    limit: "1.00",
    calls: () => [{ tool: "hedera_fact", args: { fact: "nodes" } }],
  },
  "wrong-asset": {
    header: () => [accept({ asset: "0x0000000000000000000000000000000000000001", amount: "1000" })],
    status: () => 200,
    limit: "1.00",
    calls: () => [{ tool: "hedera_fact", args: { fact: "gas-fees" } }],
  },
  "wrong-payto": {
    header: () => [accept({ payTo: "0x0000000000000000000000000000000000000002", amount: "1000" })],
    status: () => 200,
    limit: "1.00",
    calls: () => [{ tool: "hedera_fact", args: { fact: "throughput" } }],
  },
  "pinned-ok": {
    header: () => [...OTHER_CHAINS, accept({ amount: "1000" })],
    status: () => 200,
    limit: "1.00",
    calls: () => [{ tool: "hedera_fact", args: { fact: "exchange-rate" } }],
  },
  "limit-invalid-seeded": {
    header: () => [accept({ amount: "1000" })],
    status: () => 200,
    limit: "abc",
    prepare: () => plant(JSON.stringify({ date: today(), spentMicro: 250000 })),
    calls: () => [{ tool: "hedera_fact", args: { fact: "exchange-rate" } }],
  },
  "limit-invalid-empty": {
    header: () => [accept({ amount: "1000" })],
    status: () => 200,
    limit: "Infinity",
    calls: () => [{ tool: "hedera_fact", args: { fact: "exchange-rate" } }],
  },
  "limit-explicit": {
    header: () => [accept({ amount: "1000" })],
    status: () => 200,
    limit: "0.50",
    prepare: () => plant(JSON.stringify({ date: today(), spentMicro: 250000 })),
    calls: () => [{ tool: "hedera_fact", args: { fact: "exchange-rate" } }],
  },
  "ledger-corrupt": {
    header: () => [accept({ amount: "1000" })],
    status: () => 200,
    limit: "1.00",
    prepare: () => plant("{not json"),
    calls: () => [{ tool: "hedera_fact", args: { fact: "exchange-rate" } }],
  },
  "ledger-string": {
    header: () => [accept({ amount: "1000" })],
    status: () => 200,
    limit: "1.00",
    prepare: () => plant(JSON.stringify({ date: today(), spentMicro: "1000" })),
    calls: () => [{ tool: "hedera_fact", args: { fact: "exchange-rate" } }],
  },
  "ledger-negative": {
    header: () => [accept({ amount: "1000" })],
    status: () => 200,
    limit: "1.00",
    prepare: () => plant(JSON.stringify({ date: today(), spentMicro: -1 })),
    calls: () => [{ tool: "hedera_fact", args: { fact: "exchange-rate" } }],
  },
  "ledger-negative-usd": {
    header: () => [accept({ amount: "1000" })],
    status: () => 200,
    limit: "1.00",
    prepare: () => plant(JSON.stringify({ date: today(), spentUsd: -0.01 })),
    calls: () => [{ tool: "hedera_fact", args: { fact: "exchange-rate" } }],
  },
  "ledger-earlier-day": {
    header: () => [accept({ amount: "1000" })],
    status: () => 200,
    limit: "1.00",
    prepare: () => plant(JSON.stringify({ date: "2020-01-01", spentMicro: 999999 })),
    calls: () => [{ tool: "hedera_fact", args: { fact: "exchange-rate" } }],
  },
  "ledger-future": {
    header: () => [accept({ amount: "1000" })],
    status: () => 200,
    limit: "1.00",
    prepare: () => plant(JSON.stringify({ date: "2999-01-01", spentMicro: 0 })),
    calls: () => [{ tool: "hedera_fact", args: { fact: "exchange-rate" } }],
  },
  permit2: {
    header: () => [accept({ extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" } })],
    status: () => 200,
    limit: "1.00",
    calls: () => [{ tool: "hedera_fact", args: { fact: "exchange-rate" } }],
  },
  "long-validity": {
    header: () => [accept({ maxTimeoutSeconds: 315360000 })],
    status: () => 200,
    limit: "1.00",
    calls: () => [{ tool: "hedera_fact", args: { fact: "exchange-rate" } }],
  },
  "zero-amount": {
    header: () => [accept({ amount: "0" })],
    status: () => 200,
    limit: "1.00",
    calls: () => [{ tool: "hedera_fact", args: { fact: "exchange-rate" } }],
  },
  "leading-zeros": {
    header: () => [accept({ amount: "0001000" })],
    status: () => 200,
    limit: "1.00",
    calls: () => [{ tool: "hedera_fact", args: { fact: "exchange-rate" } }],
  },
  "wrong-domain": {
    header: () => [accept({ extra: { name: "Not USDC", version: "2" } })],
    status: () => 200,
    limit: "1.00",
    calls: () => [{ tool: "hedera_fact", args: { fact: "exchange-rate" } }],
  },
  "legacy-usd": {
    header: () => [accept({ amount: "1000" })],
    status: () => 200,
    limit: "1.00",
    prepare: () => plant(JSON.stringify({ date: today(), spentUsd: 0.0010004 })),
    calls: () => [{ tool: "hedera_fact", args: { fact: "exchange-rate" } }],
  },
  symlink: {
    header: () => [accept({ amount: "1000" })],
    status: () => 200,
    limit: "1.00",
    prepare: () => {
      mkdirSync(SPEND_DIR, { recursive: true });
      const target = join(SPEND_DIR, "do-not-touch.txt");
      writeFileSync(target, "DO-NOT-TOUCH");
      symlinkSync(target, SPEND_FILE);
    },
    calls: () => [{ tool: "hedera_fact", args: { fact: "exchange-rate" } }],
  },
  "head-of-line": {
    header: () => [accept({ amount: "1000" })],
    status: () => 200,
    limit: "1.00",
    hangPaths: ["hedera-facts"],
    calls: () => [],
  },
};

const scenario = process.argv[2];
const spec = challenges[scenario];
if (!spec) {
  console.error("unknown scenario " + scenario);
  process.exit(2);
}

process.env.RUBRIC_X402_DAILY_LIMIT = spec.limit;
const mock = await startServer(spec);
process.env.RUBRIC_BASE_URL = mock.url;
if (spec.prepare) spec.prepare();
const planted = spec.prepare ? readLedger().ledgerText : null;

const { dispatchX402 } = await import("../dist/x402-tools.js");
const callPaid = (tool, args) => dispatchX402(tool, args, { allowPayments: true });

let elapsedMs = null;
let results;
if (scenario === "head-of-line") {
  const hang = callPaid("hedera_fact", { fact: "exchange-rate" }).catch((err) => ({ error: String(err && err.message ? err.message : err) }));
  const hangDeadline = Date.now() + 15_000;
  while (mock.hung() < 1) {
    if (Date.now() > hangDeadline) throw new Error("hung request never reached the server");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const started = Date.now();
  const wallet = await callPaid("wallet_record", { address: "0x0000000000000000000000000000000000000001" });
  elapsedMs = Date.now() - started;
  mock.server.closeAllConnections();
  await Promise.race([hang, new Promise((resolve) => setTimeout(resolve, 500))]);
  results = [wallet];
} else {
  const planned = spec.calls();
  if (spec.parallel) {
    results = await Promise.all(planned.map((c) => callPaid(c.tool, c.args)));
  } else {
    results = [];
    for (const c of planned) results.push(await callPaid(c.tool, c.args));
  }
}

const ledger = readLedger();
let targetText = null;
try { targetText = readFileSync(join(SPEND_DIR, "do-not-touch.txt"), "utf8"); } catch { /* absent */ }

mock.server.close();
process.stdout.write(JSON.stringify({
  signedValues: mock.signed,
  signedCount: mock.signed.length,
  results,
  spentMicro: ledger.spentMicro,
  ledgerText: ledger.ledgerText,
  planted,
  modes: modes(),
  elapsedMs,
  targetText,
}));
