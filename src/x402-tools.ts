// x402 paid evidence tools. The wallet key is used only when the caller passes
// allowPayments (stdio). HTTP must pass allowPayments: false and never reaches signing.
import type { PaymentPolicy } from "@x402/core/client";
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// Spend-ledger call sites. src/x402-spend.ts will replace reserveSpend and releaseSpend
// verbatim when the shared module lands. paidCall is the only caller. The ledger path
// is ~/.rubric/x402-spend.json. There is no path override.

const BASE_NETWORK = "eip155:8453";
const BASE_NETWORK_V1 = "base";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYTO = "0xaB6731A0BcDf511c2842C768a03448075aB654ca";

// Tool maximums in USDC atomic units (6 decimals).
const MAX_MICRO: Record<string, number> = {
  screen_entity: 10_000,
  wallet_record: 5_000,
  agent_record: 5_000,
  attested_inference: 10_000,
  hedera_fact: 1_000,
  verify_audit: 2_000,
};

interface SpendState {
  date: string;
  spentMicro: number;
}

interface PaymentRequirement {
  scheme?: string;
  network?: string;
  asset?: string;
  payTo?: string;
  amount?: string | number;
  maxAmountRequired?: string | number;
}

let budgetTail: Promise<unknown> = Promise.resolve();

function withBudgetLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = budgetTail.then(fn, fn);
  budgetTail = run.then(() => undefined, () => undefined);
  return run;
}

function spendFile(): string {
  return join(homedir(), ".rubric", "x402-spend.json");
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function dailyLimitMicro(): number {
  const raw = (process.env.RUBRIC_X402_DAILY_LIMIT ?? "").trim();
  if (!raw) return 1_000_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 1_000_000;
  return Math.round(value * 1e6);
}

function microToUsd(micro: number): number {
  return Math.round(micro) / 1e6;
}

function microToMoney(micro: number): `$${string}` {
  const whole = Math.trunc(micro / 1e6);
  const frac = String(Math.abs(micro % 1e6)).padStart(6, "0").replace(/0+$/, "");
  return (frac ? `$${whole}.${frac}` : `$${whole}`) as `$${string}`;
}

function readSpend(): SpendState {
  const today = todayUtc();
  try {
    const parsed = JSON.parse(readFileSync(spendFile(), "utf8")) as Partial<SpendState>;
    if (parsed.date === today && typeof parsed.spentMicro === "number" && Number.isFinite(parsed.spentMicro)) {
      return { date: today, spentMicro: parsed.spentMicro };
    }
  } catch { /* fresh day or missing file */ }
  return { date: today, spentMicro: 0 };
}

function writeSpend(state: SpendState): void {
  const file = spendFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state));
}

async function reserveSpend(micro: number): Promise<{ ok: boolean; spentMicro: number; limitMicro: number; date: string }> {
  return withBudgetLock(async () => {
    const limitMicro = dailyLimitMicro();
    const state = readSpend();
    if (state.spentMicro + micro > limitMicro) {
      return { ok: false, spentMicro: state.spentMicro, limitMicro, date: state.date };
    }
    state.spentMicro += micro;
    writeSpend(state);
    return { ok: true, spentMicro: state.spentMicro, limitMicro, date: state.date };
  });
}

async function releaseSpend(micro: number, date: string): Promise<number> {
  return withBudgetLock(async () => {
    const state = readSpend();
    if (state.date === date) state.spentMicro = Math.max(0, state.spentMicro - micro);
    writeSpend(state);
    return state.spentMicro;
  });
}

function confirmRequired(): boolean {
  const raw = (process.env.RUBRIC_X402_CONFIRM ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function walletKey(): string {
  return process.env.RUBRIC_WALLET_KEY ?? "";
}

const NO_WALLET_MSG = {
  paymentConfigured: false,
  howTo: "These tools pay per call in USDC on Base. Use a dedicated low-balance wallet, never a main wallet. Set RUBRIC_WALLET_KEY to that key. Optional RUBRIC_X402_DAILY_LIMIT (default 1.00 USD/day; the shared spend module will lower the default to 0.25). Do not auto-approve these tools in the MCP client. RUBRIC_X402_CONFIRM=1 is a speed bump the model can set itself, not a human approval.",
};

function requirementAmount(version: number, requirement: PaymentRequirement): bigint | null {
  const raw = version === 1 ? requirement.maxAmountRequired : requirement.amount;
  if (raw === undefined || raw === null) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function pricePolicy(cap: bigint): PaymentPolicy {
  return (version, requirements) => requirements.filter((requirement) => {
    const candidate = requirement as PaymentRequirement;
    if (candidate.scheme !== "exact") return false;
    const network = candidate.network ?? "";
    if (network !== BASE_NETWORK && network !== BASE_NETWORK_V1) return false;
    if ((candidate.asset ?? "").toLowerCase() !== USDC_BASE.toLowerCase()) return false;
    if ((candidate.payTo ?? "").toLowerCase() !== PAYTO.toLowerCase()) return false;
    const amount = requirementAmount(version, candidate);
    return amount !== null && amount <= cap;
  });
}

async function createPaidClient(tool: string, key: string) {
  const { privateKeyToAccount } = await import("viem/accounts");
  const { x402Client } = await import("@x402/fetch");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  const account = privateKeyToAccount(key as `0x${string}`);
  const cap = BigInt(MAX_MICRO[tool] ?? 0);
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: account,
    networks: [BASE_NETWORK],
      policies: [pricePolicy(cap)],
  });
  client.setSpendControls({ maxAmountPerPayment: microToMoney(Number(cap)) });
  return client;
}

const clientCache = new Map<string, ReturnType<typeof createPaidClient>>();

function getClient(tool: string): ReturnType<typeof createPaidClient> {
  const key = walletKey();
  const cacheKey = `${tool}\0${key}`;
  const cached = clientCache.get(cacheKey);
  if (cached) return cached;
  const pending = createPaidClient(tool, key);
  clientCache.set(cacheKey, pending);
  return pending;
}

function requestSigned(input: RequestInfo | URL, init?: RequestInit): boolean {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return headers.has("payment-signature") || headers.has("x-payment");
}

async function paidCall(tool: string, path: string, method: string, body?: unknown): Promise<unknown> {
  const maxMicro = MAX_MICRO[tool] ?? 0;
  const maxUsd = microToUsd(maxMicro);
  if (!walletKey()) return NO_WALLET_MSG;
  const apiBase = (process.env.RUBRIC_BASE_URL ?? "https://rubric-protocol.com").replace(/[/]$/, "");
  const held = await reserveSpend(maxMicro);
  if (!held.ok) {
    return {
      error: "DAILY_BUDGET_EXCEEDED",
      spentTodayUsd: microToUsd(held.spentMicro),
      dailyLimitUsd: microToUsd(held.limitMicro),
      note: "Reserved spend for today has reached RUBRIC_X402_DAILY_LIMIT. No payment was submitted. Resets 00:00 UTC.",
    };
  }

  let signed = false;
  try {
    const client = await getClient(tool);
    const { wrapFetchWithPayment } = await import("@x402/fetch");
    const payFetch = wrapFetchWithPayment(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestSigned(input, init)) signed = true;
      return fetch(input, init);
    }, client);
    const url = apiBase + path;
    const response = await payFetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({ raw: "non-json response" })) as Record<string, unknown>;
    // A response means the payment was submitted. Count it for every status.
    return {
      httpStatus: response.status,
      ...payload,
      spentTodayUsd: microToUsd(held.spentMicro),
      dailyLimitUsd: microToUsd(held.limitMicro),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!signed) {
      const spentMicro = await releaseSpend(maxMicro, held.date);
      return {
        error: "PAYMENT_REJECTED",
        message,
        toolMaxUsd: maxUsd,
        spentTodayUsd: microToUsd(spentMicro),
        dailyLimitUsd: microToUsd(held.limitMicro),
        note: "No payment was submitted. Requirements must be USDC on Base paid to the published address, at or below this tool's maximum.",
      };
    }
    return {
      error: "PAYMENT_SUBMITTED",
      message,
      spentTodayUsd: microToUsd(held.spentMicro),
      dailyLimitUsd: microToUsd(held.limitMicro),
      note: "A payment was submitted and counts toward today's limit even though the call did not finish cleanly.",
    };
  }
}

const QUOTE_CAP = 256;

interface PendingQuote {
  id: string;
  tool: string;
  argsKey: string;
  maxPriceUsd: number;
  expiresAt: number;
}

const pendingQuotes = new Map<string, PendingQuote>();

function quoteTtlMs(): number {
  const raw = (process.env.RUBRIC_X402_CONFIRM_TTL_MS ?? "").trim();
  if (!raw) return 120_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 120_000;
  return Math.min(value, 600_000);
}

function canonicalArgs(args: Record<string, unknown>): string {
  const skip = new Set(["confirm", "quote_id"]);
  const keys = Object.keys(args).filter((key) => !skip.has(key) && args[key] !== undefined).sort();
  const normalized: Record<string, unknown> = {};
  for (const key of keys) normalized[key] = args[key];
  return JSON.stringify(normalized);
}

function pruneQuotes(now = Date.now()): void {
  for (const [id, quote] of pendingQuotes) {
    if (quote.expiresAt <= now) pendingQuotes.delete(id);
  }
  while (pendingQuotes.size > QUOTE_CAP) {
    const oldest = pendingQuotes.keys().next().value;
    if (oldest === undefined) break;
    pendingQuotes.delete(oldest);
  }
}

function issueQuote(tool: string, args: Record<string, unknown>, maxPriceUsd: number): PendingQuote {
  pruneQuotes();
  const quote: PendingQuote = {
    id: randomUUID(),
    tool,
    argsKey: canonicalArgs(args),
    maxPriceUsd,
    expiresAt: Date.now() + quoteTtlMs(),
  };
  pendingQuotes.set(quote.id, quote);
  return quote;
}

function takeQuote(tool: string, args: Record<string, unknown>, maxPriceUsd: number): PendingQuote | undefined {
  const now = Date.now();
  pruneQuotes(now);
  const id = typeof args.quote_id === "string" ? args.quote_id : "";
  const quote = id ? pendingQuotes.get(id) : undefined;
  if (!quote) return undefined;
  pendingQuotes.delete(id);
  if (quote.expiresAt <= now) return undefined;
  if (quote.tool !== tool || quote.argsKey !== canonicalArgs(args) || quote.maxPriceUsd !== maxPriceUsd) return undefined;
  return quote;
}

const confirmField = {
  type: "boolean",
  description: "When RUBRIC_X402_CONFIRM=1, omit this to get a one-time quote. The model can set it, so this is not a human approval. Pass true only with the quote_id from that quote.",
};

const quoteField = {
  type: "string",
  description: "quoteId from the previous confirmationRequired response. Same tool and arguments, single use, expires quickly.",
};

function withConfirm(schema: { type: string; properties: Record<string, unknown>; required?: string[] }) {
  return { ...schema, properties: { ...schema.properties, confirm: confirmField, quote_id: quoteField } };
}

export const X402_TOOLS = [
  { name: "screen_entity", description: "PAID ($0.01 USDC): sanctions and export-control screening across OFAC SDN + Consolidated, UN, UK OFSI, EU, and BIS lists (76K+ entries). Returns per-list results plus a signed, Hedera-anchored attestation - audit evidence you screened, against which list versions, and what it said. Requires RUBRIC_WALLET_KEY.", inputSchema: withConfirm({ type: "object", properties: { name: { type: "string", description: "entity or individual name" }, query_id: { type: "string", description: "optional caller reference echoed into evidence" } }, required: ["name"] }) },
  { name: "wallet_record", description: "PAID ($0.005 USDC): attested x402 payment history for a Base/EVM buyer wallet from an append-only settlement ledger - settlements, first/last seen, spend, services. Evidence, not opinion.", inputSchema: withConfirm({ type: "object", properties: { address: { type: "string", description: "0x wallet address" } }, required: ["address"] }) },
  { name: "agent_record", description: "PAID ($0.005 USDC): unforgeable operating history for any agent attesting through Rubric - record count, first-seen, continuity, recent activity, from HCS-anchored records that cannot be backdated.", inputSchema: withConfirm({ type: "object", properties: { agent_id: { type: "string" } }, required: ["agent_id"] }) },
  { name: "attested_inference", description: "PAID ($0.01 USDC): gpt-4o-mini completion plus attestation binding prompt hash, response hash, exact model version, timestamp - evidence of which model said what, when.", inputSchema: withConfirm({ type: "object", properties: { prompt: { type: "string" }, max_tokens: { type: "number" } }, required: ["prompt"] }) },
  { name: "hedera_fact", description: "PAID ($0.001 USDC): one attested Hedera network fact (exchange-rate, gas-fees, supply, nodes, throughput, topic-state) with the attestation ID of the served snapshot.", inputSchema: withConfirm({ type: "object", properties: { fact: { type: "string", enum: ["exchange-rate", "gas-fees", "supply", "nodes", "throughput", "topic-state"] } }, required: ["fact"] }) },
  { name: "verify_audit", description: "PAID ($0.002 USDC): independent audit of a Rubric attestation - signature, HCS sequence, mirror-node confirmation - returning a signed verdict with its own attestation ID.", inputSchema: withConfirm({ type: "object", properties: { attestation_id: { type: "string" } }, required: ["attestation_id"] }) },
];

export interface X402CallOptions {
  allowPayments?: boolean;
}

export async function dispatchX402(name: string, a: Record<string, unknown>, opts?: X402CallOptions): Promise<unknown> {
  const known = Object.prototype.hasOwnProperty.call(MAX_MICRO, name);
  if (!known) return null;
  if (opts?.allowPayments !== true) return { error: "X402_DISABLED_IN_HTTP_MODE" };
  if (confirmRequired()) {
    const maxPriceUsd = microToUsd(MAX_MICRO[name] ?? 0);
    if (a.confirm !== true) {
      const quote = issueQuote(name, a, maxPriceUsd);
      return {
        confirmationRequired: true,
        quoteId: quote.id,
        tool: name,
        maxPriceUsd,
        network: BASE_NETWORK,
        asset: USDC_BASE,
        payTo: PAYTO,
        expiresAt: new Date(quote.expiresAt).toISOString(),
        note: "Speed bump only. The model sets confirm, so this is not human approval. Call the same tool with the same arguments, confirm: true, and this quoteId before it expires. The quote works once. No payment was made.",
      };
    }
    if (!takeQuote(name, a, maxPriceUsd)) {
      return {
        error: "CONFIRMATION_INVALID",
        tool: name,
        maxPriceUsd,
        note: "No matching unused quote for this tool, arguments, and price. Quotes are single use and expire quickly. No payment was made.",
      };
    }
  }
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
