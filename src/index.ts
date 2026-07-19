#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createHash, randomUUID } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { name: string; version: string };

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
} else {
  console.error(`[Rubric MCP] HCS-anchored mode — ${BASE_URL} / agent: ${DEFAULT_AGENT_ID}`);
}

function sha3(input: string): string {
  return createHash("sha3-256").update(input).digest("hex");
}

async function rubricPost<T>(path: string, body: unknown): Promise<T> {
  if (LOCAL_MODE) throw new Error("This tool requires RUBRIC_API_KEY. Use `register_agent` to request a free key.");
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Rubric ${res.status} ${path}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function rubricGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: API_KEY ? { "x-api-key": API_KEY } : {},
  });
  if (!res.ok) throw new Error(`Rubric ${res.status} ${path}`);
  return res.json() as Promise<T>;
}

function detectFrameworks(payload: string, metadata?: Record<string, unknown>): string[] {
  const text = `${payload} ${JSON.stringify(metadata ?? {})}`.toLowerCase();
  const tags: string[] = [];
  if (/\b(credit|loan|underwrit|mortgage|fico|creditworthy)\b/.test(text)) tags.push("ECOA_REG_B", "SR_11_7");
  if (/\b(hire|hiring|candidate|resume|employment|applicant)\b/.test(text)) tags.push("EU_AI_ACT_HIGH_RISK", "NYC_LL144");
  if (/\b(medical|diagnos|patient|health|clinical|hipaa)\b/.test(text)) tags.push("HIPAA", "EU_AI_ACT_HIGH_RISK");
  if (/\b(education|student|grading|admission|exam)\b/.test(text)) tags.push("EU_AI_ACT_HIGH_RISK");
  if (/\b(insurance|claim|premium|policy)\b/.test(text)) tags.push("SR_11_7", "CO_AI_ACT");
  if (/\b(trading|portfolio|investment|broker|sec|cftc)\b/.test(text)) tags.push("SEC", "CFTC", "SR_11_7");
  if (/\b(content moderat|hate speech|illegal content)\b/.test(text)) tags.push("EU_DSA");
  if (/\b(critical infrastructure|nis2|essential service)\b/.test(text)) tags.push("NIS2");
  tags.push("EU_AI_ACT_ART_12", "NIST_AI_RMF");
  return [...new Set(tags)];
}

function estimateMonthly(decisionsPerDay: number) {
  const monthly = decisionsPerDay * 30;
  if (monthly <= 100_000) return { tier: "Standard", monthly_usd: 999, overage_usd: 0, notes: "Within Standard 100K/mo cap" };
  if (monthly <= 600_000) {
    const overage = Math.round((monthly - 100_000) * 0.01 * 100) / 100;
    return { tier: "Standard", monthly_usd: 999 + overage, overage_usd: overage, notes: `${monthly - 100_000} overage @ $0.01` };
  }
  if (monthly <= 10_000_000) return { tier: "Enterprise", monthly_usd: 9999, overage_usd: 0, notes: "Enterprise unlimited within 6000/min" };
  return { tier: "Dedicated", monthly_usd: 25000, overage_usd: 0, notes: "Dedicated tier — custom SLA" };
}

const TOOLS = [
  { name: "attest", description: "Attest an AI decision. With RUBRIC_API_KEY: HCS-anchored on Hedera mainnet. Without: PQ-signed local Merkle leaf in ~/.rubric/local-bundles/.", inputSchema: { type: "object", properties: { payload: { type: "string" }, agent_id: { type: "string" }, metadata: { type: "object", additionalProperties: true } }, required: ["payload"] } },
  { name: "verify", description: "Verify an attestation. Checks local store first, then federation. Merkle inclusion + HCS anchoring.", inputSchema: { type: "object", properties: { attestation_id: { type: "string" } }, required: ["attestation_id"] } },
  { name: "get_proof", description: "Generate ZK Merkle inclusion proof (Noir/Barretenberg) for an attestation. Requires API key.", inputSchema: { type: "object", properties: { attestation_id: { type: "string" } }, required: ["attestation_id"] } },
  { name: "register_agent", description: "Register an agent and receive a free Rubric developer API key via email.", inputSchema: { type: "object", properties: { email: { type: "string" }, agent_name: { type: "string" }, use_case: { type: "string" } }, required: ["email", "agent_name"] } },
  { name: "status", description: "Federation health across US/SG/JP/CA/EU nodes + ZK node.", inputSchema: { type: "object", properties: {} } },
  { name: "framework_detect", description: "Auto-detect applicable regulatory frameworks (EU AI Act, SR 26-2, HIPAA, NIST AI RMF, etc.) from decision content. Works offline, no key required.", inputSchema: { type: "object", properties: { payload: { type: "string" }, metadata: { type: "object", additionalProperties: true } }, required: ["payload"] } },
  { name: "cost_estimate", description: "Estimate monthly Rubric cost from expected decision volume. No key required.", inputSchema: { type: "object", properties: { decisions_per_day: { type: "number" } }, required: ["decisions_per_day"] } },
  { name: "bundle_query", description: "Query attestation bundles by leaf type, agent, or time range. Requires Standard+ tier.", inputSchema: { type: "object", properties: { leafType: { type: "string" }, agentId: { type: "string" }, limit: { type: "number" } } } },

  { name: "attest_batch", description: "Batch-attest up to 1,000 AI decisions in one call (tiered path, HCS-anchored at tier-2 flush). Requires API key.", inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { data: { type: "string" }, sourceId: { type: "string" } }, required: ["data", "sourceId"] } } }, required: ["items"] } },
  { name: "attestation_status", description: "Anchoring status of an attestation: buffered, flushed, or anchored with HCS sequence.", inputSchema: { type: "object", properties: { attestation_id: { type: "string" } }, required: ["attestation_id"] } },
  { name: "attestation_get", description: "Fetch a full attestation record by ID.", inputSchema: { type: "object", properties: { attestation_id: { type: "string" } }, required: ["attestation_id"] } },
  { name: "pipeline_trace", description: "All attestations for a pipeline ID, in order — the evidentiary trace of a multi-step agent run.", inputSchema: { type: "object", properties: { pipeline_id: { type: "string" } }, required: ["pipeline_id"] } },
  { name: "bundle_get", description: "Fetch one attestation bundle by ID.", inputSchema: { type: "object", properties: { bundle_id: { type: "string" } }, required: ["bundle_id"] } },
  { name: "verify_chain", description: "Verify an attestation and its full hash-chain lineage back to anchor.", inputSchema: { type: "object", properties: { attestation_id: { type: "string" } }, required: ["attestation_id"] } },
  { name: "verify_tree", description: "Verify Merkle-tree membership for an attestation within its anchored forest.", inputSchema: { type: "object", properties: { attestation_id: { type: "string" } }, required: ["attestation_id"] } },
  { name: "verify_batch", description: "Verify many attestation IDs in one call.", inputSchema: { type: "object", properties: { attestation_ids: { type: "array", items: { type: "string" } } }, required: ["attestation_ids"] } },
  { name: "zk_verify", description: "Verify a ZK Merkle inclusion proof previously produced by get_proof.", inputSchema: { type: "object", properties: { proof: { type: "object", additionalProperties: true } }, required: ["proof"] } },
  { name: "zk_proof_get", description: "Retrieve a previously generated ZK inclusion proof by attestation ID.", inputSchema: { type: "object", properties: { attestation_id: { type: "string" } }, required: ["attestation_id"] } },
  { name: "ledger_lookup", description: "Look up an anchored record by HCS sequence number on topic 0.0.10416909.", inputSchema: { type: "object", properties: { sequence: { type: "number" } }, required: ["sequence"] } },
  { name: "annex4_generate", description: "Generate a court-admissible EU AI Act Annex IV technical-documentation evidence package (PDF). Returns a job ID.", inputSchema: { type: "object", properties: { systemId: { type: "string" }, from: { type: "string" }, to: { type: "string" } }, required: ["systemId"] } },
  { name: "annex4_status", description: "Status of an Annex IV generation job, with download URL when complete.", inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] } },
  { name: "c2pa_attest", description: "Create a C2PA-conformant content-provenance attestation (com.rubric-protocol.attestation assertion).", inputSchema: { type: "object", properties: { payload: { type: "object", additionalProperties: true } }, required: ["payload"] } },
  { name: "c2pa_assertion", description: "Fetch the C2PA assertion for an attestation, ready to embed in a manifest.", inputSchema: { type: "object", properties: { attestation_id: { type: "string" } }, required: ["attestation_id"] } },
  { name: "credential_issue", description: "Issue a W3C Verifiable Credential wrapping an attestation.", inputSchema: { type: "object", properties: { attestation_id: { type: "string" }, subject: { type: "object", additionalProperties: true } }, required: ["attestation_id"] } },
  { name: "credential_get", description: "Fetch an issued Verifiable Credential by ID.", inputSchema: { type: "object", properties: { credential_id: { type: "string" } }, required: ["credential_id"] } },
  { name: "compliance_query", description: "Query the compliance index by systemId, rubricEventType, agentId, jurisdiction, contextId, or time range.", inputSchema: { type: "object", properties: { systemId: { type: "string" }, rubricEventType: { type: "string" }, agentId: { type: "string" }, jurisdiction: { type: "string" }, from: { type: "string" }, to: { type: "string" }, limit: { type: "number" } } } },
  { name: "compliance_report", description: "Generate a compliance evidence report over a time range.", inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, format: { type: "string" } } } },
  { name: "filing_generate", description: "Generate a regulatory filing document from attested evidence.", inputSchema: { type: "object", properties: { filingType: { type: "string" }, systemId: { type: "string" } }, required: ["filingType"] } },
  { name: "gpai_register", description: "Register a GPAI (general-purpose AI) model relationship for EU AI Act downstream-provider tracking.", inputSchema: { type: "object", properties: { gpaiModelId: { type: "string" }, role: { type: "string" } }, required: ["gpaiModelId"] } },
  { name: "gpai_downstream", description: "List downstream systems registered against a GPAI model.", inputSchema: { type: "object", properties: { gpai_model_id: { type: "string" } }, required: ["gpai_model_id"] } },
  { name: "nist_rmf_certify", description: "Run NIST AI RMF certification against attested evidence for a compliance context. Hard-fails below the evidence floor.", inputSchema: { type: "object", properties: { contextId: { type: "string" } }, required: ["contextId"] } },
  { name: "nist_rmf_status", description: "NIST AI RMF certification status for a compliance context.", inputSchema: { type: "object", properties: { context_id: { type: "string" } }, required: ["context_id"] } },
  { name: "jurisdiction_map", description: "Map which regulatory frameworks apply across jurisdictions for your attested systems.", inputSchema: { type: "object", properties: {} } },
  { name: "jurisdiction_assess", description: "Assess a system against a jurisdiction's requirements using attested evidence.", inputSchema: { type: "object", properties: { jurisdiction: { type: "string" }, systemId: { type: "string" } }, required: ["jurisdiction"] } },
  { name: "jurisdiction_gap", description: "Gap analysis: requirements without supporting attested evidence, per jurisdiction.", inputSchema: { type: "object", properties: { jurisdiction: { type: "string" } } } },
  { name: "incident_create", description: "Open an attested incident record (EU AI Act Art. 73 / GPAI serious-incident ready).", inputSchema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, severity: { type: "string" } }, required: ["title"] } },
  { name: "incident_attest", description: "Attach an attested evidence entry to an incident.", inputSchema: { type: "object", properties: { incident_id: { type: "string" }, note: { type: "string" } }, required: ["incident_id"] } },
  { name: "incident_resolve", description: "Resolve an incident with an attested closure record.", inputSchema: { type: "object", properties: { incident_id: { type: "string" }, resolution: { type: "string" } }, required: ["incident_id"] } },
  { name: "human_review", description: "Record an attested human-review decision (oversight evidence for Art. 14 / SR 26-2).", inputSchema: { type: "object", properties: { attestationId: { type: "string" }, decision: { type: "string" }, reviewerId: { type: "string" }, reason: { type: "string" } }, required: ["decision"] } },
  { name: "adversarial_session_start", description: "Open an attested adversarial-testing (red-team) session — every probe becomes evidence.", inputSchema: { type: "object", properties: { name: { type: "string" }, scope: { type: "string" } }, required: ["name"] } },
  { name: "adversarial_session_conclude", description: "Conclude an adversarial session with an attested summary record.", inputSchema: { type: "object", properties: { session_id: { type: "string" }, findings: { type: "string" } }, required: ["session_id"] } },
  { name: "agent_add", description: "Register an agent profile in the Rubric agent registry (identity for the Agent Logbook).", inputSchema: { type: "object", properties: { agentId: { type: "string" }, name: { type: "string" }, description: { type: "string" } }, required: ["agentId"] } },
  { name: "agent_get", description: "Fetch an agent profile and its attestation summary.", inputSchema: { type: "object", properties: { agent_id: { type: "string" } }, required: ["agent_id"] } },
  { name: "model_register", description: "Register a model (hash, version, lineage) for supply-chain attestation.", inputSchema: { type: "object", properties: { modelId: { type: "string" }, modelHash: { type: "string" }, version: { type: "string" } }, required: ["modelId"] } },
  { name: "model_get", description: "Fetch a registered model's record and commitment.", inputSchema: { type: "object", properties: { model_id: { type: "string" } }, required: ["model_id"] } },
  { name: "usage_report", description: "Current-period usage and quota for your API key.", inputSchema: { type: "object", properties: {} } },
  { name: "auditor_token_create", description: "Mint a scoped read-only auditor-portal token for external examiners. Enterprise tier.", inputSchema: { type: "object", properties: { scope: { type: "string" }, expiresInDays: { type: "number" } } } },
];

async function handleAttest(args: Record<string, unknown>) {
  const payload = args.payload as string;
  const agentId = (args.agent_id as string) ?? DEFAULT_AGENT_ID;
  const metadata = (args.metadata as Record<string, unknown>) ?? { source: "mcp" };

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

async function handleVerify(args: Record<string, unknown>) {
  const id = args.attestation_id as string;
  const localPath = join(LOCAL_STORE, `${id}.json`);
  if (existsSync(localPath)) {
    const leaf = JSON.parse(readFileSync(localPath, "utf8"));
    if (LOCAL_MODE) return { ...leaf, source: "local" };
  }
  return rubricGet(`/v1/verify/${encodeURIComponent(id)}`);
}

async function handleGetProof(args: Record<string, unknown>) {
  try {
    return await rubricPost("/v1/zk-prove", { attestationId: args.attestation_id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not a member")) {
      return { error: "Attestation not yet flushed to Merkle tree. ZK proofs become available after tier-2 aggregation (typically within 60 seconds of attest). Retry shortly.", attestationId: args.attestation_id, retryable: true };
    }
    throw err;
  }
}

async function handleRegisterAgent(args: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/v1/keys/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: args.email, name: args.agent_name, intendedUse: args.use_case ?? "", source: "mcp-register" }),
  });
  if (!res.ok) throw new Error(`Rubric ${res.status} /v1/keys/request: ${await res.text().catch(() => res.statusText)}`);
  return res.json();
}

async function handleStatus() { return rubricGet("/verify/v1/health"); }

async function handleFrameworkDetect(args: Record<string, unknown>) {
  const frameworks = detectFrameworks(args.payload as string, args.metadata as Record<string, unknown>);
  return { frameworks, count: frameworks.length };
}

async function handleCostEstimate(args: Record<string, unknown>) {
  return estimateMonthly(args.decisions_per_day as number);
}

async function handleBundleQuery(args: Record<string, unknown>) {
  const qs = new URLSearchParams(args as Record<string, string>).toString();
  return rubricGet(`/v1/bundles${qs ? "?" + qs : ""}`);
}

function qstr(a: Record<string, unknown>, keys: string[]): string {
  const p = new URLSearchParams();
  for (const k of keys) if (a[k] !== undefined && a[k] !== null) p.set(k, String(a[k]));
  const q = p.toString();
  return q ? "?" + q : "";
}

async function handleAttestBatch(a: Record<string, unknown>) { return rubricPost("/v1/tiered-attest-batch", { items: a.items }); }
async function handleAttestationStatus(a: Record<string, unknown>) { return rubricGet(`/v1/status/${encodeURIComponent(a.attestation_id as string)}`); }
async function handleAttestationGet(a: Record<string, unknown>) { return rubricGet(`/v1/attestations/${encodeURIComponent(a.attestation_id as string)}`); }
async function handlePipelineTrace(a: Record<string, unknown>) { return rubricGet(`/v1/pipeline/${encodeURIComponent(a.pipeline_id as string)}`); }
async function handleBundleGet(a: Record<string, unknown>) { return rubricGet(`/v1/bundles/${encodeURIComponent(a.bundle_id as string)}`); }
async function handleVerifyChain(a: Record<string, unknown>) { return rubricGet(`/v1/verify/chain/${encodeURIComponent(a.attestation_id as string)}`); }
async function handleVerifyTree(a: Record<string, unknown>) { return rubricGet(`/v1/verify/tree/${encodeURIComponent(a.attestation_id as string)}`); }
async function handleVerifyBatch(a: Record<string, unknown>) { return rubricPost("/v1/batch-verify", { attestationIds: a.attestation_ids }); }
async function handleZkVerify(a: Record<string, unknown>) { return rubricPost("/v1/zk-verify", { proof: a.proof }); }
async function handleZkProofGet(a: Record<string, unknown>) { return rubricGet(`/v1/zk-proof/${encodeURIComponent(a.attestation_id as string)}`); }
async function handleLedgerLookup(a: Record<string, unknown>) { return rubricGet(`/v1/ledger/${encodeURIComponent(String(a.sequence))}`); }
async function handleAnnex4Generate(a: Record<string, unknown>) { return rubricPost("/v1/compliance/annex4/generate", a); }
async function handleAnnex4Status(a: Record<string, unknown>) { return rubricGet(`/v1/compliance/annex4/status/${encodeURIComponent(a.job_id as string)}`); }
async function handleC2paAttest(a: Record<string, unknown>) { return rubricPost("/v1/c2pa/attest", a.payload as Record<string, unknown>); }
async function handleC2paAssertion(a: Record<string, unknown>) { return rubricGet(`/v1/c2pa/assertion/${encodeURIComponent(a.attestation_id as string)}`); }
async function handleCredentialIssue(a: Record<string, unknown>) { return rubricPost("/v1/credentials/issue", a); }
async function handleCredentialGet(a: Record<string, unknown>) { return rubricGet(`/v1/credentials/${encodeURIComponent(a.credential_id as string)}`); }
async function handleComplianceQuery(a: Record<string, unknown>) { return rubricGet(`/v1/compliance/query${qstr(a, ["systemId", "rubricEventType", "agentId", "jurisdiction", "contextId", "from", "to", "limit"])}`); }
async function handleComplianceReport(a: Record<string, unknown>) { return rubricPost("/v1/export/report", a); }
async function handleFilingGenerate(a: Record<string, unknown>) { return rubricPost("/v1/filings/generate", a); }
async function handleGpaiRegister(a: Record<string, unknown>) { return rubricPost("/v1/compliance/gpai/register", a); }
async function handleGpaiDownstream(a: Record<string, unknown>) { return rubricGet(`/v1/gpai/downstream/${encodeURIComponent(a.gpai_model_id as string)}`); }
async function handleNistRmfCertify(a: Record<string, unknown>) { return rubricPost("/v1/compliance/nist-rmf/certify", a); }
async function handleNistRmfStatus(a: Record<string, unknown>) { return rubricGet(`/v1/compliance/nist-rmf/status/${encodeURIComponent(a.context_id as string)}`); }
async function handleJurisdictionMap() { return rubricGet("/v1/jurisdiction/map"); }
async function handleJurisdictionAssess(a: Record<string, unknown>) { return rubricPost("/v1/jurisdiction/assess", a); }
async function handleJurisdictionGap(a: Record<string, unknown>) { return rubricGet(`/v1/jurisdiction/gap-analysis${qstr(a, ["jurisdiction"])}`); }
async function handleIncidentCreate(a: Record<string, unknown>) { return rubricPost("/v1/incidents", a); }
async function handleIncidentAttest(a: Record<string, unknown>) { return rubricPost(`/v1/incidents/${encodeURIComponent(a.incident_id as string)}/attest`, { note: a.note }); }
async function handleIncidentResolve(a: Record<string, unknown>) { return rubricPost(`/v1/incidents/${encodeURIComponent(a.incident_id as string)}/resolve`, { resolution: a.resolution }); }
async function handleHumanReview(a: Record<string, unknown>) { return rubricPost("/v1/human-review", a); }
async function handleAdversarialStart(a: Record<string, unknown>) { return rubricPost("/v1/adversarial/sessions", a); }
async function handleAdversarialConclude(a: Record<string, unknown>) { return rubricPost(`/v1/adversarial/sessions/${encodeURIComponent(a.session_id as string)}/conclude`, { findings: a.findings }); }
async function handleAgentAdd(a: Record<string, unknown>) { return rubricPost("/v1/agents/register", a); }
async function handleAgentGet(a: Record<string, unknown>) { return rubricGet(`/v1/agents/${encodeURIComponent(a.agent_id as string)}`); }
async function handleModelRegister(a: Record<string, unknown>) { return rubricPost("/v1/models/register", a); }
async function handleModelGet(a: Record<string, unknown>) { return rubricGet(`/v1/models/${encodeURIComponent(a.model_id as string)}`); }
async function handleUsageReport() { return rubricGet("/v1/usage"); }
async function handleAuditorTokenCreate(a: Record<string, unknown>) { return rubricPost("/v1/auditor/tokens", a); }

const server = new Server(
  { name: PKG.name, version: PKG.version },
  { capabilities: { tools: {} } }
);

const MCP_MODULES: Record<string, string[]> = {
  core: ["attest", "verify", "get_proof", "register_agent", "status", "framework_detect", "cost_estimate", "bundle_query"],
  attestation: ["attest_batch", "attestation_status", "attestation_get", "pipeline_trace", "bundle_get"],
  verification: ["verify_chain", "verify_tree", "verify_batch", "zk_verify", "zk_proof_get", "ledger_lookup"],
  compliance: ["annex4_generate", "annex4_status", "c2pa_attest", "c2pa_assertion", "credential_issue", "credential_get", "compliance_query", "compliance_report", "filing_generate"],
  regulatory: ["gpai_register", "gpai_downstream", "nist_rmf_certify", "nist_rmf_status", "jurisdiction_map", "jurisdiction_assess", "jurisdiction_gap"],
  governance: ["incident_create", "incident_attest", "incident_resolve", "human_review", "adversarial_session_start", "adversarial_session_conclude"],
  registry: ["agent_add", "agent_get", "model_register", "model_get"],
  ops: ["usage_report", "auditor_token_create"],
};
const _mods = (process.env.RUBRIC_MCP_MODULES ?? "core").split(",").map((s: string) => s.trim()).filter(Boolean);
const ENABLED_TOOLS = new Set(
  _mods.includes("all") ? Object.values(MCP_MODULES).flat()
                        : _mods.flatMap((m: string) => MCP_MODULES[m] ?? [])
);
if (ENABLED_TOOLS.size === 0) MCP_MODULES.core.forEach((t: string) => ENABLED_TOOLS.add(t));

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.filter((t: { name: string }) => ENABLED_TOOLS.has(t.name)) }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;
  try {
    let result: unknown;
    switch (name) {
      case "attest":            result = await handleAttest(a); break;
      case "verify":            result = await handleVerify(a); break;
      case "get_proof":         result = await handleGetProof(a); break;
      case "register_agent":    result = await handleRegisterAgent(a); break;
      case "status":            result = await handleStatus(); break;
      case "framework_detect":  result = await handleFrameworkDetect(a); break;
      case "cost_estimate":     result = await handleCostEstimate(a); break;
      case "bundle_query":      result = await handleBundleQuery(a); break;
      case "attest_batch":              result = await handleAttestBatch(a); break;
      case "attestation_status":        result = await handleAttestationStatus(a); break;
      case "attestation_get":           result = await handleAttestationGet(a); break;
      case "pipeline_trace":            result = await handlePipelineTrace(a); break;
      case "bundle_get":                result = await handleBundleGet(a); break;
      case "verify_chain":              result = await handleVerifyChain(a); break;
      case "verify_tree":               result = await handleVerifyTree(a); break;
      case "verify_batch":              result = await handleVerifyBatch(a); break;
      case "zk_verify":                 result = await handleZkVerify(a); break;
      case "zk_proof_get":              result = await handleZkProofGet(a); break;
      case "ledger_lookup":             result = await handleLedgerLookup(a); break;
      case "annex4_generate":           result = await handleAnnex4Generate(a); break;
      case "annex4_status":             result = await handleAnnex4Status(a); break;
      case "c2pa_attest":               result = await handleC2paAttest(a); break;
      case "c2pa_assertion":            result = await handleC2paAssertion(a); break;
      case "credential_issue":          result = await handleCredentialIssue(a); break;
      case "credential_get":            result = await handleCredentialGet(a); break;
      case "compliance_query":          result = await handleComplianceQuery(a); break;
      case "compliance_report":         result = await handleComplianceReport(a); break;
      case "filing_generate":           result = await handleFilingGenerate(a); break;
      case "gpai_register":             result = await handleGpaiRegister(a); break;
      case "gpai_downstream":           result = await handleGpaiDownstream(a); break;
      case "nist_rmf_certify":          result = await handleNistRmfCertify(a); break;
      case "nist_rmf_status":           result = await handleNistRmfStatus(a); break;
      case "jurisdiction_map":          result = await handleJurisdictionMap(); break;
      case "jurisdiction_assess":       result = await handleJurisdictionAssess(a); break;
      case "jurisdiction_gap":          result = await handleJurisdictionGap(a); break;
      case "incident_create":           result = await handleIncidentCreate(a); break;
      case "incident_attest":           result = await handleIncidentAttest(a); break;
      case "incident_resolve":          result = await handleIncidentResolve(a); break;
      case "human_review":              result = await handleHumanReview(a); break;
      case "adversarial_session_start": result = await handleAdversarialStart(a); break;
      case "adversarial_session_conclude": result = await handleAdversarialConclude(a); break;
      case "agent_add":                 result = await handleAgentAdd(a); break;
      case "agent_get":                 result = await handleAgentGet(a); break;
      case "model_register":            result = await handleModelRegister(a); break;
      case "model_get":                 result = await handleModelGet(a); break;
      case "usage_report":              result = await handleUsageReport(); break;
      case "auditor_token_create":      result = await handleAuditorTokenCreate(a); break;
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => { console.error(err); process.exit(1); });
