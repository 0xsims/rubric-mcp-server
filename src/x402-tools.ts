// x402 paid evidence tools. The wallet key is used only when the caller passes
// allowPayments (stdio). HTTP must pass allowPayments: false and never reaches signing.
// The ledger, lock, and payment checks live in ./x402-spend.js. That file is shared
// verbatim with the 2.2.4 package.
import { randomUUID } from "crypto";
import {
  BASE_NETWORK,
  DEFAULT_PAYMENT_TIMEOUT_MS,
  PAY_TO,
  SpendLedgerError,
  TOOL_MAX_MICRO,
  USDC_BASE,
  attachSpendHooks,
  dailyLimitMicro,
  fetchWithTimeout,
  microToUsd,
  microToMoney,
  readSpend,
  requirementAllowed,
  runWithSpendContext,
} from "./x402-spend.js";

const BUDGET_NOTE = "Raise RUBRIC_X402_DAILY_LIMIT or retry after 00:00 UTC. No payment was made.";
const PRICE_NOTE = "Payment requirements exceed this tool's maximum. No payment was made.";
const PIN_NOTE = "Payment requirements must be an EIP-3009 USDC transfer on Base to the Rubric payee, at or below this tool's maximum, with a validity window of at most 5 minutes. No payment was made.";
const TIMEOUT_NOTE = "The paid request timed out. If a payment was already signed, it still counts toward the daily limit.";

const NO_WALLET_MSG = {
  paymentConfigured: false,
  howTo: "These tools pay per call in USDC on Base. Use a dedicated low-balance wallet, never a main wallet. Set RUBRIC_WALLET_KEY to that key. Optional RUBRIC_X402_DAILY_LIMIT (default 0.25 USD/day). Do not auto-approve these tools in the MCP client. RUBRIC_X402_CONFIRM=1 is a speed bump the model can set itself, not a human approval.",
};

function walletKey(): string {
  return process.env.RUBRIC_WALLET_KEY ?? "";
}

function apiBase(): string {
  return (process.env.RUBRIC_BASE_URL ?? "https://rubric-protocol.com").replace(/[/]$/, "");
}

function confirmRequired(): boolean {
  const raw = (process.env.RUBRIC_X402_CONFIRM ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function budgetExceeded(spentMicro: number, limitMicro: number): Record<string, unknown> {
  return {
    error: "DAILY_BUDGET_EXCEEDED",
    spentTodayUsd: microToUsd(spentMicro),
    dailyLimitUsd: microToUsd(limitMicro),
    note: BUDGET_NOTE,
  };
}

function ledgerRefusal(err: unknown): Record<string, unknown> | null {
  if (err instanceof SpendLedgerError) return { error: err.code, note: err.message };
  return null;
}

type PayFetch = (url: string, init: { method: string; headers: { "content-type": string }; body: string | undefined }) => Promise<Response>;
const payFetchByCap = new Map<string, Promise<PayFetch>>();

function getPayFetch(maxMicro: number): Promise<PayFetch> {
  const key = walletKey();
  const cacheKey = `${maxMicro}\0${key}`;
  const existing = payFetchByCap.get(cacheKey);
  if (existing) return existing;
  const created = (async () => {
    const { privateKeyToAccount } = await import("viem/accounts");
    const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
    const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
    const account = privateKeyToAccount(key as `0x${string}`);
    const client = new x402Client();
    const maxAtomic = BigInt(maxMicro);
    registerExactEvmScheme(client, {
      signer: account,
      networks: [BASE_NETWORK],
      policies: [(version, reqs) => reqs.filter((req) => requirementAllowed(version, req, maxAtomic))],
    });
    client.setSpendControls({ maxAmountPerPayment: microToMoney(maxMicro) });
    attachSpendHooks(client, maxAtomic);
    return wrapFetchWithPayment(fetchWithTimeout(fetch, DEFAULT_PAYMENT_TIMEOUT_MS), client) as PayFetch;
  })();
  payFetchByCap.set(cacheKey, created);
  return created;
}

async function explainRefusal(err: unknown, maxMicro: number): Promise<Record<string, unknown> | null> {
  const ledger = ledgerRefusal(err);
  if (ledger) return ledger;
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("LEDGER_SYMLINK")) return { error: "LEDGER_SYMLINK", note: msg };
  if (msg.includes("LEDGER_LOCK_TIMEOUT")) return { error: "LEDGER_LOCK_TIMEOUT", note: msg };
  if (msg.includes("LEDGER_INVALID")) return { error: "LEDGER_INVALID", note: msg };
  if (msg.includes("DAILY_BUDGET_EXCEEDED")) {
    try {
      const state = await readSpend();
      return budgetExceeded(state.spentMicro, dailyLimitMicro());
    } catch (readErr) {
      return ledgerRefusal(readErr) ?? { error: "DAILY_BUDGET_EXCEEDED", note: BUDGET_NOTE };
    }
  }
  if (msg.includes("PRICE_ABOVE_TOOL_MAX") || msg.includes("maxAmountPerPayment")) {
    return { error: "PRICE_ABOVE_TOOL_MAX", toolMaxUsd: microToUsd(maxMicro), note: PRICE_NOTE };
  }
  if (
    msg.includes("PAYMENT_REQUIREMENTS_REJECTED") ||
    msg.includes("filtered out by policies") ||
    msg.includes("spendControls") ||
    msg.includes("No network/scheme registered") ||
    msg.includes("No client registered")
  ) {
    return { error: "PAYMENT_REQUIREMENTS_REJECTED", toolMaxUsd: microToUsd(maxMicro), note: PIN_NOTE };
  }
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError" || msg.includes("timed out")) {
    return { error: "PAYMENT_TIMEOUT", note: TIMEOUT_NOTE };
  }
  return null;
}

async function paidCall(path: string, method: string, body: unknown | undefined, maxMicro: number): Promise<unknown> {
  if (!walletKey()) return NO_WALLET_MSG;
  const limitMicro = dailyLimitMicro();
  let state;
  try {
    state = await readSpend();
  } catch (err) {
    const refused = ledgerRefusal(err);
    if (refused) return refused;
    throw err;
  }
  if (state.spentMicro >= limitMicro) return budgetExceeded(state.spentMicro, limitMicro);
  const url = apiBase() + path;
  const bodyStr = body === undefined ? undefined : JSON.stringify(body);
  const payFetch = await getPayFetch(maxMicro);
  let response: Response;
  try {
    response = await runWithSpendContext(() => payFetch(url, { method, headers: { "content-type": "application/json" }, body: bodyStr }));
  } catch (err) {
    const refused = await explainRefusal(err, maxMicro);
    if (refused) return refused;
    throw err;
  }
  const payload = await response.json().catch(() => ({ raw: "non-json response" })) as Record<string, unknown>;
  try {
    const spent = await readSpend();
    return { httpStatus: response.status, ...payload, spentTodayUsd: microToUsd(spent.spentMicro), dailyLimitUsd: microToUsd(limitMicro) };
  } catch (err) {
    const refused = ledgerRefusal(err);
    if (refused) return { httpStatus: response.status, ...refused };
    throw err;
  }
}

const QUOTE_CAP = 256;

interface PendingQuote {
  id: string;
  tool: string;
  argsKey: string;
  maxPriceUsd: number;
  maxMicro: number;
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

function issueQuote(tool: string, args: Record<string, unknown>, maxMicro: number): PendingQuote {
  pruneQuotes();
  const quote: PendingQuote = {
    id: randomUUID(),
    tool,
    argsKey: canonicalArgs(args),
    maxPriceUsd: microToUsd(maxMicro),
    maxMicro,
    expiresAt: Date.now() + quoteTtlMs(),
  };
  pendingQuotes.set(quote.id, quote);
  return quote;
}

function takeQuote(tool: string, args: Record<string, unknown>, maxMicro: number): PendingQuote | undefined {
  const now = Date.now();
  pruneQuotes(now);
  const id = typeof args.quote_id === "string" ? args.quote_id : "";
  const quote = id ? pendingQuotes.get(id) : undefined;
  if (!quote) return undefined;
  pendingQuotes.delete(id);
  if (quote.expiresAt <= now) return undefined;
  if (quote.tool !== tool || quote.argsKey !== canonicalArgs(args) || quote.maxMicro !== maxMicro) return undefined;
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

function routePaid(name: string, a: Record<string, unknown>, maxMicro: number): Promise<unknown> {
  switch (name) {
    case "screen_entity": return paidCall("/v1/x402/attested-screening", "POST", { name: a.name, queryId: a.query_id }, maxMicro);
    case "wallet_record": return paidCall("/v1/x402/wallet-record/" + encodeURIComponent(String(a.address ?? "")), "GET", undefined, maxMicro);
    case "agent_record": return paidCall("/v1/x402/agent-record/" + encodeURIComponent(String(a.agent_id ?? "")), "GET", undefined, maxMicro);
    case "attested_inference": return paidCall("/v1/x402/attested-inference", "POST", { messages: [{ role: "user", content: String(a.prompt ?? "") }], max_tokens: Math.min(Number(a.max_tokens ?? 500), 1000) }, maxMicro);
    case "hedera_fact": return paidCall("/v1/x402/hedera-facts/" + encodeURIComponent(String(a.fact ?? "")), "GET", undefined, maxMicro);
    case "verify_audit": return paidCall("/v1/x402/verify-audit", "POST", { attestationId: a.attestation_id }, maxMicro);
    default: return Promise.resolve(null);
  }
}

export async function dispatchX402(name: string, a: Record<string, unknown>, opts?: X402CallOptions): Promise<unknown> {
  const known = Object.prototype.hasOwnProperty.call(TOOL_MAX_MICRO, name);
  if (!known) return null;
  if (opts?.allowPayments !== true) return { error: "X402_DISABLED_IN_HTTP_MODE" };
  const toolMax = TOOL_MAX_MICRO[name] ?? 0;
  let maxMicro = toolMax;
  if (confirmRequired()) {
    const maxPriceUsd = microToUsd(toolMax);
    if (a.confirm !== true) {
      const quote = issueQuote(name, a, toolMax);
      return {
        confirmationRequired: true,
        quoteId: quote.id,
        tool: name,
        maxPriceUsd,
        network: BASE_NETWORK,
        asset: USDC_BASE,
        payTo: PAY_TO,
        expiresAt: new Date(quote.expiresAt).toISOString(),
        note: "Speed bump only. The model sets confirm, so this is not human approval. Call the same tool with the same arguments, confirm: true, and this quoteId before it expires. The quote works once. The confirming call checks the server's requirements against this quoted price with the same network, asset, payTo, amount, permit2, validity, and EIP-712 rules. No payment was made.",
      };
    }
    const quote = takeQuote(name, a, toolMax);
    if (!quote) {
      return {
        error: "CONFIRMATION_INVALID",
        tool: name,
        maxPriceUsd,
        note: "No matching unused quote for this tool, arguments, and price. Quotes are single use and expire quickly. No payment was made.",
      };
    }
    // The quoted atomic price is the cap requirementAllowed applies on this call.
    maxMicro = quote.maxMicro;
  }
  return routePaid(name, a, maxMicro);
}
