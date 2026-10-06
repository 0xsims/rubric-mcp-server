// x402 paid evidence tools - user-funded wallet, spend-governed.
// Every paid response carries an attestation ID. Money safety:
// (1) no wallet key -> helpful guidance, never an error stack
// (2) daily spend ceiling, default $1.00, RUBRIC_X402_DAILY_LIMIT overrides
// (3) pre-flight price check: refuse if the 402 quote exceeds the tool max
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const BASE = (process.env.RUBRIC_BASE_URL ?? "https://rubric-protocol.com").replace(/[/]$/, "");
const HTTP_MODE = process.argv.includes("--http");
const WALLET_KEY = process.env.RUBRIC_WALLET_KEY ?? "";
const DAILY_LIMIT_USD = Number(process.env.RUBRIC_X402_DAILY_LIMIT ?? "1.00");
const SPEND_FILE = join(homedir(), ".rubric", "x402-spend.json");

// tool max prices in USD - refuse any 402 quoting more
const MAX_PRICE: Record<string, number> = {
  screen_entity: 0.01, wallet_record: 0.005, agent_record: 0.005,
  attested_inference: 0.01, hedera_fact: 0.001, verify_audit: 0.002,
};

interface SpendState {
  date: string;
  spentUsd: number;
}

function spendState(): SpendState {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const s = JSON.parse(readFileSync(SPEND_FILE, "utf8")) as SpendState;
    if (s.date === today) return s;
  } catch { /* fresh day or missing file */ }
  return { date: today, spentUsd: 0 };
}

function recordSpend(usd: number): number {
  const s = spendState();
  s.spentUsd = Math.round((s.spentUsd + usd) * 1e6) / 1e6;
  mkdirSync(join(homedir(), ".rubric"), { recursive: true });
  writeFileSync(SPEND_FILE, JSON.stringify(s));
  return s.spentUsd;
}

const NO_WALLET_MSG = { paymentConfigured: false, howTo: "These tools pay per call in USDC on Base (fractions of a cent). Setup: (1) create a wallet, fund with a few USD of USDC on Base; (2) export RUBRIC_WALLET_KEY=<private key> in the MCP server env; (3) optional RUBRIC_X402_DAILY_LIMIT (default 1.00 USD/day). Keys never leave this process." };

type PayFetch = (url: string, init: { method: string; headers: { "content-type": string }; body: string | undefined }) => Promise<Response>;
let payFetchP: Promise<PayFetch> | null = null;

function getPayFetch(): Promise<PayFetch> {
  if (HTTP_MODE) return Promise.reject(new Error("x402 payments are disabled in HTTP mode"));
  if (!payFetchP) payFetchP = (async () => {
    const { privateKeyToAccount } = await import("viem/accounts");
    const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
    const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
    const account = privateKeyToAccount(WALLET_KEY as `0x${string}`);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: account });
    return wrapFetchWithPayment(fetch, client) as PayFetch;
  })();
  return payFetchP;
}

async function quotedPriceUsd(url: string, method: string, body: string | undefined): Promise<number | null> {
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body });
  if (r.status !== 402) return null;
  const j = await r.json().catch(() => null) as { accepts?: Array<{ amount?: string | number; maxAmountRequired?: string | number }> } | null;
  const amt = j && j.accepts && j.accepts[0] && (j.accepts[0].amount ?? j.accepts[0].maxAmountRequired);
  return amt ? Number(amt) / 1e6 : null;
}

async function paidCall(tool: string, path: string, method: string, body?: unknown): Promise<unknown> {
  if (HTTP_MODE) return { error: "X402_DISABLED_IN_HTTP_MODE" };
  if (!WALLET_KEY) return NO_WALLET_MSG;
  const st = spendState();
  const max = MAX_PRICE[tool] ?? 0.01;
  if (st.spentUsd + max > DAILY_LIMIT_USD) return { error: "DAILY_BUDGET_EXCEEDED", spentTodayUsd: st.spentUsd, dailyLimitUsd: DAILY_LIMIT_USD, note: "Raise RUBRIC_X402_DAILY_LIMIT or retry after 00:00 UTC. No payment was made." };
  const url = BASE + path;
  const bodyStr = body === undefined ? undefined : JSON.stringify(body);
  const quote = await quotedPriceUsd(url, method, bodyStr);
  if (quote !== null && quote > max) return { error: "PRICE_ABOVE_TOOL_MAX", quotedUsd: quote, toolMaxUsd: max, note: "Server quoted more than this tool permits. No payment was made." };
  const payFetch = await getPayFetch();
  const r = await payFetch(url, { method, headers: { "content-type": "application/json" }, body: bodyStr });
  const j = await r.json().catch(() => ({ raw: "non-json response" })) as Record<string, unknown>;
  const spent = r.status === 200 ? recordSpend(quote ?? max) : spendState().spentUsd;
  return { httpStatus: r.status, ...j, spentTodayUsd: spent, dailyLimitUsd: DAILY_LIMIT_USD };
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
