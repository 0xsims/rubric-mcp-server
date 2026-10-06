// x402 paid evidence tools - user-funded wallet, spend-governed.
// Before any signature:
// (1) no wallet key -> guidance, no payment
// (2) the requirement actually being signed must be USDC on Base, to the Rubric payee, at or below the tool max
// (3) that price is reserved against the daily ceiling under a lock, and the reservation counts even when the response is not HTTP 200
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

const BASE = (process.env.RUBRIC_BASE_URL ?? "https://rubric-protocol.com").replace(/[/]$/, "");
const WALLET_KEY = process.env.RUBRIC_WALLET_KEY ?? "";
const DAILY_LIMIT_USD = Number(process.env.RUBRIC_X402_DAILY_LIMIT ?? "1.00");
const SPEND_DIR = join(homedir(), ".rubric");
const SPEND_FILE = join(SPEND_DIR, "x402-spend.json");
const SPEND_LOCK = SPEND_FILE + ".lock";

// Base mainnet USDC and the Rubric payee published in the x402 catalog.
const BASE_NETWORK = "eip155:8453" as const;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0xaB6731A0BcDf511c2842C768a03448075aB654ca";

// tool max prices in USD - enforced on the payment requirements that would be signed
const MAX_PRICE: Record<string, number> = {
  screen_entity: 0.01, wallet_record: 0.005, agent_record: 0.005,
  attested_inference: 0.01, hedera_fact: 0.001, verify_audit: 0.002,
};

const BUDGET_NOTE = "Raise RUBRIC_X402_DAILY_LIMIT or retry after 00:00 UTC. No payment was made.";
const PRICE_NOTE = "Payment requirements exceed this tool's maximum. No payment was made.";
const PIN_NOTE = "Payment requirements must be USDC on Base to the Rubric payee, at or below this tool's maximum. No payment was made.";

interface SpendState {
  date: string;
  spentUsd: number;
}

interface PaymentReq {
  scheme?: string;
  network?: string;
  asset?: string;
  payTo?: string;
  amount?: string | number;
  maxAmountRequired?: string | number;
}

function usdToMicros(usd: number): number {
  return Math.round(usd * 1e6);
}

function microsToUsd(micros: number): number {
  return micros / 1e6;
}

function spendState(): SpendState {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const s = JSON.parse(readFileSync(SPEND_FILE, "utf8")) as SpendState;
    if (s.date === today && Number.isFinite(s.spentUsd)) return s;
  } catch { /* fresh day or missing file */ }
  return { date: today, spentUsd: 0 };
}

function sleepMs(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

function acquireSpendLock(): void {
  mkdirSync(SPEND_DIR, { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(SPEND_LOCK, "wx");
      try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      try {
        const st = statSync(SPEND_LOCK);
        if (Date.now() - st.mtimeMs > 15_000) unlinkSync(SPEND_LOCK);
      } catch { /* lock disappeared */ }
      if (Date.now() - start > 10_000) throw new Error("Timed out waiting for the x402 spend lock");
      sleepMs(20);
    }
  }
}

function releaseSpendLock(): void {
  try { unlinkSync(SPEND_LOCK); } catch { /* already released */ }
}

function withSpendFile<T>(fn: () => T): T {
  acquireSpendLock();
  try { return fn(); } finally { releaseSpendLock(); }
}

function writeSpendAtomic(state: SpendState): void {
  mkdirSync(SPEND_DIR, { recursive: true });
  const tmp = join(SPEND_DIR, `.x402-spend.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(state));
  try {
    renameSync(tmp, SPEND_FILE);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function tryReserve(usd: number): { ok: true; spentUsd: number } | { ok: false; spentUsd: number } {
  return withSpendFile(() => {
    const s = spendState();
    const next = usdToMicros(s.spentUsd) + usdToMicros(usd);
    if (next > usdToMicros(DAILY_LIMIT_USD)) return { ok: false, spentUsd: s.spentUsd };
    s.spentUsd = microsToUsd(next);
    writeSpendAtomic(s);
    return { ok: true, spentUsd: s.spentUsd };
  });
}

function releaseReserve(usd: number): void {
  withSpendFile(() => {
    const s = spendState();
    const next = Math.max(0, usdToMicros(s.spentUsd) - usdToMicros(usd));
    s.spentUsd = microsToUsd(next);
    writeSpendAtomic(s);
  });
}

function budgetExceeded(spentUsd: number): Record<string, unknown> {
  return { error: "DAILY_BUDGET_EXCEEDED", spentTodayUsd: spentUsd, dailyLimitUsd: DAILY_LIMIT_USD, note: BUDGET_NOTE };
}

let paymentTail: Promise<void> = Promise.resolve();

function withPaymentLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = paymentTail.then(fn, fn);
  paymentTail = run.then(() => undefined, () => undefined);
  return run;
}

const NO_WALLET_MSG = { paymentConfigured: false, howTo: "These tools pay per call in USDC on Base (fractions of a cent). Setup: (1) create a wallet, fund with a few USD of USDC on Base; (2) export RUBRIC_WALLET_KEY=<private key> in the MCP server env; (3) optional RUBRIC_X402_DAILY_LIMIT (default 1.00 USD/day). Keys never leave this process." };

type PayFetch = (url: string, init: { method: string; headers: { "content-type": string }; body: string | undefined }) => Promise<Response>;
const payFetchByTool = new Map<string, Promise<PayFetch>>();

function usdMoney(usd: number): string {
  const micros = usdToMicros(usd);
  const whole = Math.trunc(micros / 1_000_000);
  const frac = String(Math.abs(micros % 1_000_000)).padStart(6, "0").replace(/0+$/, "");
  return frac.length > 0 ? `$${whole}.${frac}` : `$${whole}`;
}

function requirementAtomic(version: number, req: PaymentReq): bigint | null {
  const raw = version === 1 ? req.maxAmountRequired : req.amount;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0) return null;
    return BigInt(raw);
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  return BigInt(raw);
}

function requirementAllowed(version: number, req: PaymentReq, maxAtomic: bigint): boolean {
  if (req.scheme !== "exact") return false;
  const network = String(req.network ?? "").toLowerCase();
  if (network !== BASE_NETWORK && network !== "base") return false;
  if (String(req.asset ?? "").toLowerCase() !== USDC_BASE.toLowerCase()) return false;
  if (String(req.payTo ?? "").toLowerCase() !== PAY_TO.toLowerCase()) return false;
  const atomic = requirementAtomic(version, req);
  return atomic !== null && atomic <= maxAtomic;
}

function getPayFetch(maxUsd: number): Promise<PayFetch> {
  const key = usdMoney(maxUsd);
  const existing = payFetchByTool.get(key);
  if (existing) return existing;
  const created = (async () => {
    const { privateKeyToAccount } = await import("viem/accounts");
    const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
    const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
    const account = privateKeyToAccount(WALLET_KEY as `0x${string}`);
    const client = new x402Client();
    const maxAtomic = BigInt(usdToMicros(maxUsd));
    registerExactEvmScheme(client, {
      signer: account,
      networks: [BASE_NETWORK],
      policies: [(version, reqs) => reqs.filter((req) => requirementAllowed(version, req, maxAtomic))],
    });
    client.setSpendControls({ maxAmountPerPayment: usdMoney(maxUsd) });
    let pendingUsd = 0;
    client.onBeforePaymentCreation(async (ctx) => {
      const atomic = requirementAtomic(ctx.paymentRequired.x402Version, ctx.selectedRequirements);
      if (atomic === null) return { abort: true, reason: "PRICE_ABOVE_TOOL_MAX" };
      const usd = microsToUsd(Number(atomic));
      const reserved = tryReserve(usd);
      if (!reserved.ok) return { abort: true, reason: "DAILY_BUDGET_EXCEEDED" };
      pendingUsd = usd;
    });
    client.onPaymentCreationFailure(async () => {
      if (pendingUsd > 0) {
        const usd = pendingUsd;
        pendingUsd = 0;
        releaseReserve(usd);
      }
    });
    return wrapFetchWithPayment(fetch, client) as PayFetch;
  })();
  payFetchByTool.set(key, created);
  return created;
}

function explainRefusal(err: unknown, maxUsd: number): Record<string, unknown> | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("DAILY_BUDGET_EXCEEDED")) {
    return budgetExceeded(withSpendFile(() => spendState().spentUsd));
  }
  if (msg.includes("PRICE_ABOVE_TOOL_MAX") || msg.includes("maxAmountPerPayment")) {
    return { error: "PRICE_ABOVE_TOOL_MAX", toolMaxUsd: maxUsd, note: PRICE_NOTE };
  }
  if (
    msg.includes("filtered out by policies") ||
    msg.includes("spendControls") ||
    msg.includes("No network/scheme registered") ||
    msg.includes("No client registered")
  ) {
    return { error: "PAYMENT_REQUIREMENTS_REJECTED", toolMaxUsd: maxUsd, note: PIN_NOTE };
  }
  return null;
}

async function paidCall(tool: string, path: string, method: string, body?: unknown): Promise<unknown> {
  if (!WALLET_KEY) return NO_WALLET_MSG;
  const max = MAX_PRICE[tool] ?? 0.01;
  return withPaymentLock(async () => {
    const spentUsd = withSpendFile(() => spendState().spentUsd);
    if (usdToMicros(spentUsd) >= usdToMicros(DAILY_LIMIT_USD)) return budgetExceeded(spentUsd);
    const url = BASE + path;
    const bodyStr = body === undefined ? undefined : JSON.stringify(body);
    const payFetch = await getPayFetch(max);
    let r: Response;
    try {
      r = await payFetch(url, { method, headers: { "content-type": "application/json" }, body: bodyStr });
    } catch (err) {
      const refused = explainRefusal(err, max);
      if (refused) return refused;
      throw err;
    }
    const j = await r.json().catch(() => ({ raw: "non-json response" })) as Record<string, unknown>;
    const spent = withSpendFile(() => spendState().spentUsd);
    return { httpStatus: r.status, ...j, spentTodayUsd: spent, dailyLimitUsd: DAILY_LIMIT_USD };
  });
}

export const X402_TOOLS = [
  { name: "screen_entity", description: "PAID ($0.01 USDC): sanctions and export-control screening across OFAC SDN + Consolidated, UN, UK OFSI, EU, and BIS lists (76K+ entries). Returns per-list results plus a signed, Hedera-anchored attestation - audit evidence you screened, against which list versions, and what it said. Requires RUBRIC_WALLET_KEY.", inputSchema: { type: "object", properties: { name: { type: "string", description: "entity or individual name" }, query_id: { type: "string", description: "optional caller reference echoed into evidence" } }, required: ["name"] } },
  { name: "wallet_record", description: "PAID ($0.005 USDC): attested x402 payment history for a Base/EVM buyer wallet from an append-only settlement ledger - settlements, first/last seen, spend, services. Evidence, not opinion.", inputSchema: { type: "object", properties: { address: { type: "string", description: "0x wallet address" } }, required: ["address"] } },
  { name: "agent_record", description: "PAID ($0.005 USDC): unforgeable operating history for any agent attesting through Rubric - record count, first-seen, continuity, recent activity, from HCS-anchored records that cannot be backdated.", inputSchema: { type: "object", properties: { agent_id: { type: "string" } }, required: ["agent_id"] } },
  { name: "attested_inference", description: "PAID ($0.01 USDC): gpt-4o-mini completion plus attestation binding prompt hash, response hash, exact model version, timestamp - evidence of which model said what, when.", inputSchema: { type: "object", properties: { prompt: { type: "string" }, max_tokens: { type: "number" } }, required: ["prompt"] } },
  { name: "hedera_fact", description: "PAID ($0.001 USDC): one attested Hedera network fact (exchange-rate, gas-fees, supply, nodes, throughput, topic-state) with the attestation ID of the served snapshot.", inputSchema: { type: "object", properties: { fact: { type: "string", enum: ["exchange-rate", "gas-fees", "supply", "nodes", "throughput", "topic-state"] } }, required: ["fact"] } },
  { name: "verify_audit", description: "PAID ($0.002 USDC): independent audit of a Rubric attestation - signature, HCS sequence, mirror-node confirmation - returning a signed verdict with its own attestation ID.", inputSchema: { type: "object", properties: { attestation_id: { type: "string" } }, required: ["attestation_id"] } },
];

export async function dispatchX402(name: string, a: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "screen_entity": return paidCall(name, "/v1/x402/attested-screening", "POST", { name: a.name, queryId: a.query_id });
    case "wallet_record": return paidCall(name, "/v1/x402/wallet-record/" + encodeURIComponent(String(a.address ?? "")), "GET");
    case "agent_record": return paidCall(name, "/v1/x402/agent-record/" + encodeURIComponent(String(a.agent_id ?? "")), "GET");
    case "attested_inference": return paidCall(name, "/v1/x402/attested-inference", "POST", { messages: [{ role: "user", content: String(a.prompt ?? "") }], max_tokens: Math.min(Number(a.max_tokens ?? 500), 1000) });
    case "hedera_fact": return paidCall(name, "/v1/x402/hedera-facts/" + encodeURIComponent(String(a.fact ?? "")), "GET");
    case "verify_audit": return paidCall(name, "/v1/x402/verify-audit", "POST", { attestationId: a.attestation_id });
    default: return null;
  }
}
