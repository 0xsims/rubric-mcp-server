#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createHash, randomUUID } from "crypto";
const API_KEY = process.env.RUBRIC_API_KEY ?? "";
const BASE_URL = (process.env.RUBRIC_BASE_URL ?? "https://rubric-protocol.com").replace(/\/$/, "");
const DEFAULT_AGENT_ID = process.env.RUBRIC_AGENT_ID ?? "mcp-agent";
const LOCAL_MODE = !API_KEY;
const LOCAL_STORE = join(homedir(), ".rubric", "local-bundles");
mkdirSync(LOCAL_STORE, { recursive: true });
if (LOCAL_MODE) {
    console.error("[Rubric MCP] ⚠  LOCAL-ONLY MODE");
    console.error("[Rubric MCP]   Attestations are PQ-signed locally but NOT HCS-anchored.");
    console.error("[Rubric MCP]   For Hedera mainnet anchoring, set RUBRIC_API_KEY.");
    console.error("[Rubric MCP]   Request a free key via the `register_agent` tool.");
}
else {
    console.error(`[Rubric MCP] HCS-anchored mode — ${BASE_URL} / agent: ${DEFAULT_AGENT_ID}`);
}
function sha3(input) {
    return createHash("sha3-256").update(input).digest("hex");
}
async function rubricPost(path, body) {
    if (LOCAL_MODE)
        throw new Error("This tool requires RUBRIC_API_KEY. Use `register_agent` to request a free key.");
    const res = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`Rubric ${res.status} ${path}: ${text}`);
    }
    return res.json();
}
async function rubricGet(path) {
    const res = await fetch(`${BASE_URL}${path}`, {
        headers: API_KEY ? { "x-api-key": API_KEY } : {},
    });
    if (!res.ok)
        throw new Error(`Rubric ${res.status} ${path}`);
    return res.json();
}
function detectFrameworks(payload, metadata) {
    const text = `${payload} ${JSON.stringify(metadata ?? {})}`.toLowerCase();
    const tags = [];
    if (/\b(credit|loan|underwrit|mortgage|fico|creditworthy)\b/.test(text))
        tags.push("ECOA_REG_B", "SR_11_7");
    if (/\b(hire|hiring|candidate|resume|employment|applicant)\b/.test(text))
        tags.push("EU_AI_ACT_HIGH_RISK", "NYC_LL144");
    if (/\b(medical|diagnos|patient|health|clinical|hipaa)\b/.test(text))
        tags.push("HIPAA", "EU_AI_ACT_HIGH_RISK");
    if (/\b(education|student|grading|admission|exam)\b/.test(text))
        tags.push("EU_AI_ACT_HIGH_RISK");
    if (/\b(insurance|claim|premium|policy)\b/.test(text))
        tags.push("SR_11_7", "CO_AI_ACT");
    if (/\b(trading|portfolio|investment|broker|sec|cftc)\b/.test(text))
        tags.push("SEC", "CFTC", "SR_11_7");
    if (/\b(content moderat|hate speech|illegal content)\b/.test(text))
        tags.push("EU_DSA");
    if (/\b(critical infrastructure|nis2|essential service)\b/.test(text))
        tags.push("NIS2");
    tags.push("EU_AI_ACT_ART_12", "NIST_AI_RMF");
    return [...new Set(tags)];
}
function estimateMonthly(decisionsPerDay) {
    const monthly = decisionsPerDay * 30;
    if (monthly <= 100_000)
        return { tier: "Standard", monthly_usd: 999, overage_usd: 0, notes: "Within Standard 100K/mo cap" };
    if (monthly <= 600_000) {
        const overage = Math.round((monthly - 100_000) * 0.01 * 100) / 100;
        return { tier: "Standard", monthly_usd: 999 + overage, overage_usd: overage, notes: `${monthly - 100_000} overage @ $0.01` };
    }
    if (monthly <= 10_000_000)
        return { tier: "Enterprise", monthly_usd: 9999, overage_usd: 0, notes: "Enterprise unlimited within 6000/min" };
    return { tier: "Dedicated", monthly_usd: 25000, overage_usd: 0, notes: "Dedicated tier — custom SLA" };
}
const TOOLS = [
    { name: "attest", description: "Attest an AI decision. With RUBRIC_API_KEY: HCS-anchored on Hedera mainnet. Without: PQ-signed local Merkle leaf in ~/.rubric/local-bundles/.", inputSchema: { type: "object", properties: { payload: { type: "string" }, agent_id: { type: "string" }, metadata: { type: "object", additionalProperties: true } }, required: ["payload"] } },
    { name: "verify", description: "Verify an attestation. Checks local store first, then federation. Merkle inclusion + HCS anchoring.", inputSchema: { type: "object", properties: { attestation_id: { type: "string" } }, required: ["attestation_id"] } },
    { name: "get_proof", description: "Generate ZK Merkle inclusion proof (Noir/Barretenberg) for an attestation. Requires API key.", inputSchema: { type: "object", properties: { attestation_id: { type: "string" } }, required: ["attestation_id"] } },
    { name: "register_agent", description: "Register an agent and receive a free Rubric developer API key via email.", inputSchema: { type: "object", properties: { email: { type: "string" }, agent_name: { type: "string" }, use_case: { type: "string" } }, required: ["email", "agent_name"] } },
    { name: "status", description: "Federation health across US/SG/JP/CA/EU nodes + ZK node.", inputSchema: { type: "object", properties: {} } },
    { name: "framework_detect", description: "Auto-detect applicable regulatory frameworks (EU AI Act, SR 11-7, HIPAA, NIST AI RMF, etc.) from decision content. Works offline, no key required.", inputSchema: { type: "object", properties: { payload: { type: "string" }, metadata: { type: "object", additionalProperties: true } }, required: ["payload"] } },
    { name: "cost_estimate", description: "Estimate monthly Rubric cost from expected decision volume. No key required.", inputSchema: { type: "object", properties: { decisions_per_day: { type: "number" } }, required: ["decisions_per_day"] } },
    { name: "bundle_query", description: "Query attestation bundles by leaf type, agent, or time range. Requires Standard+ tier.", inputSchema: { type: "object", properties: { leafType: { type: "string" }, agentId: { type: "string" }, limit: { type: "number" } } } },
];
async function handleAttest(args) {
    const payload = args.payload;
    const agentId = args.agent_id ?? DEFAULT_AGENT_ID;
    const metadata = args.metadata ?? { source: "mcp" };
    if (LOCAL_MODE) {
        const id = randomUUID();
        const timestamp = new Date().toISOString();
        const leafHash = sha3(JSON.stringify({ payload, agentId, metadata, timestamp }));
        const leaf = { attestationId: id, leafHash, timestamp, agentId, metadata, mode: "local", anchored: false };
        writeFileSync(join(LOCAL_STORE, `${id}.json`), JSON.stringify(leaf, null, 2));
        return { ...leaf, upgrade: "Set RUBRIC_API_KEY for HCS anchoring, or use `register_agent` for a free key." };
    }
    return rubricPost("/v1/tiered-attest", { agentId, sourceId: agentId, data: payload, metadata });
}
async function handleVerify(args) {
    const id = args.attestation_id;
    const localPath = join(LOCAL_STORE, `${id}.json`);
    if (existsSync(localPath)) {
        const leaf = JSON.parse(readFileSync(localPath, "utf8"));
        if (LOCAL_MODE)
            return { ...leaf, source: "local" };
    }
    return rubricGet(`/v1/verify/${encodeURIComponent(id)}`);
}
async function handleGetProof(args) {
    try {
        return await rubricPost("/v1/zk-prove", { attestationId: args.attestation_id });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not a member")) {
            return { error: "Attestation not yet flushed to Merkle tree. ZK proofs become available after tier-2 aggregation (typically within 60 seconds of attest). Retry shortly.", attestationId: args.attestation_id, retryable: true };
        }
        throw err;
    }
}
async function handleRegisterAgent(args) {
    const res = await fetch(`${BASE_URL}/v1/keys/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: args.email, agentName: args.agent_name, useCase: args.use_case ?? "", source: "mcp-register" }),
    });
    if (!res.ok)
        throw new Error(`Rubric ${res.status} /v1/keys/request: ${await res.text().catch(() => res.statusText)}`);
    return res.json();
}
async function handleStatus() { return rubricGet("/verify/v1/health"); }
async function handleFrameworkDetect(args) {
    const frameworks = detectFrameworks(args.payload, args.metadata);
    return { frameworks, count: frameworks.length };
}
async function handleCostEstimate(args) {
    return estimateMonthly(args.decisions_per_day);
}
async function handleBundleQuery(args) {
    const qs = new URLSearchParams(args).toString();
    return rubricGet(`/v1/bundles${qs ? "?" + qs : ""}`);
}
const server = new Server({ name: "@rubric-protocol/mcp-server", version: "2.0.1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {});
    try {
        let result;
        switch (name) {
            case "attest":
                result = await handleAttest(a);
                break;
            case "verify":
                result = await handleVerify(a);
                break;
            case "get_proof":
                result = await handleGetProof(a);
                break;
            case "register_agent":
                result = await handleRegisterAgent(a);
                break;
            case "status":
                result = await handleStatus();
                break;
            case "framework_detect":
                result = await handleFrameworkDetect(a);
                break;
            case "cost_estimate":
                result = await handleCostEstimate(a);
                break;
            case "bundle_query":
                result = await handleBundleQuery(a);
                break;
            default:
                return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((err) => { console.error(err); process.exit(1); });
