// x402 paid evidence tools - user-funded wallet, spend-governed.
// The ledger, lock, and payment checks live in ./x402-spend.js so later packages can copy that file verbatim.
import {
  BASE_NETWORK,
  DEFAULT_PAYMENT_TIMEOUT_MS,
  SpendLedgerError,
  TOOL_MAX_MICRO,
  attachSpendHooks,
  dailyLimitMicro,
  fetchWithTimeout,
  microToUsd,
  microToMoney,
  readSpend,
  requirementAllowed,
  runWithSpendContext,
} from "./x402-spend.js";

const BASE = (process.env.RUBRIC_BASE_URL ?? "https://rubric-protocol.com").replace(/[/]$/, "");
const WALLET_KEY = process.env.RUBRIC_WALLET_KEY ?? "";

const BUDGET_NOTE = "Raise RUBRIC_X402_DAILY_LIMIT or retry after 00:00 UTC. No payment was made.";
const PRICE_NOTE = "Payment requirements exceed this tool's maximum. No payment was made.";
const PIN_NOTE = "Payment requirements must be an EIP-3009 USDC transfer on Base to the Rubric payee, at or below this tool's maximum, with a validity window of at most 5 minutes. No payment was made.";
const TIMEOUT_NOTE = "The paid request timed out. If a payment was already signed, it still counts toward the daily limit.";

const NO_WALLET_MSG = {
  paymentConfigured: false,
  howTo: "These tools pay per call in USDC on Base (fractions of a cent). Setup: (1) create a dedicated wallet and fund it with a small USDC balance on Base; (2) export RUBRIC_WALLET_KEY=<private key> in the MCP server env; (3) optional RUBRIC_X402_DAILY_LIMIT (default 0.25 USD/day). The key is stored in plaintext in the client config. The model can call a paid tool, and a prompt injection can trigger a payment. Do not auto-approve these paid tools in the MCP client.",
};

type PayFetch = (url: string, init: { method: string; headers: { "content-type": string }; body: string | undefined }) => Promise<Response>;
const payFetchByTool = new Map<string, Promise<PayFetch>>();

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

function getPayFetch(maxMicro: number): Promise<PayFetch> {
  const key = String(maxMicro);
  const existing = payFetchByTool.get(key);
  if (existing) return existing;
  const created = (async () => {
    const { privateKeyToAccount } = await import("viem/accounts");
    const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
    const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
    const account = privateKeyToAccount(WALLET_KEY as `0x${string}`);
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
  payFetchByTool.set(key, created);
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

async function paidCall(tool: string, path: string, method: string, body?: unknown): Promise<unknown> {
  if (!WALLET_KEY) return NO_WALLET_MSG;
  const maxMicro = TOOL_MAX_MICRO[tool] ?? 10_000;
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
  const url = BASE + path;
  const bodyStr = body === undefined ? undefined : JSON.stringify(body);
  const payFetch = await getPayFetch(maxMicro);
  let r: Response;
  try {
    r = await runWithSpendContext(() => payFetch(url, { method, headers: { "content-type": "application/json" }, body: bodyStr }));
  } catch (err) {
    const refused = await explainRefusal(err, maxMicro);
    if (refused) return refused;
    throw err;
  }
  const j = await r.json().catch(() => ({ raw: "non-json response" })) as Record<string, unknown>;
  try {
    const spent = await readSpend();
    return { httpStatus: r.status, ...j, spentTodayUsd: microToUsd(spent.spentMicro), dailyLimitUsd: microToUsd(limitMicro) };
  } catch (err) {
    const refused = ledgerRefusal(err);
    if (refused) return { httpStatus: r.status, ...refused };
    throw err;
  }
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
