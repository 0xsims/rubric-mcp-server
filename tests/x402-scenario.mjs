// Mock x402 upstream. No real payments, no broadcast.
import http from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYTO = "0xaB6731A0BcDf511c2842C768a03448075aB654ca";
const SPEND_FILE = join(homedir(), ".rubric", "x402-spend.json");

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

function readSpent() {
  try {
    const s = JSON.parse(readFileSync(SPEND_FILE, "utf8"));
    return s.spentUsd;
  } catch {
    return null;
  }
}

function startServer(challengeAccepts, bodyAccepts, paidStatus) {
  const signed = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const sig = req.headers["payment-signature"] || req.headers["x-payment"];
      if (sig) {
        signed.push(signedValue(sig));
        const status = paidStatus();
        const body = status === 200 ? { ok: true, attestationId: "test" } : { error: "upstream failed" };
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      const headerBody = paymentRequired(challengeAccepts());
      const jsonBody = paymentRequired(bodyAccepts ? bodyAccepts() : challengeAccepts());
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
      });
    });
  });
}

const scenario = process.argv[2];

const challenges = {
  "over-price": {
    // Header is what gets signed. Body quotes the tool max ($0.001) so a preflight would pass.
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
};

const spec = challenges[scenario];
if (!spec) {
  console.error("unknown scenario " + scenario);
  process.exit(2);
}

process.env.RUBRIC_X402_DAILY_LIMIT = spec.limit;
const mock = await startServer(spec.header, spec.body, spec.status);
process.env.RUBRIC_BASE_URL = mock.url;

const { dispatchX402 } = await import("../dist/x402-tools.js");
const planned = spec.calls();
let results;
if (spec.parallel) {
  results = await Promise.all(planned.map((c) => dispatchX402(c.tool, c.args)));
} else {
  results = [];
  for (const c of planned) results.push(await dispatchX402(c.tool, c.args));
}

mock.server.close();
process.stdout.write(JSON.stringify({
  signedValues: mock.signed,
  signedCount: mock.signed.length,
  results,
  spentUsd: readSpent(),
}));
