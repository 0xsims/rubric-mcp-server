#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const API_KEY = process.env.RUBRIC_API_KEY ?? "";
const BASE_URL = (process.env.RUBRIC_BASE_URL ?? "https://rubric-protocol.com").replace(/\/$/, "");
const DEFAULT_AGENT_ID = process.env.RUBRIC_AGENT_ID ?? "mcp-agent";

if (!API_KEY) {
  console.error("[Rubric MCP] RUBRIC_API_KEY not set.");
  process.exit(1);
}

async function rubricPost<T>(path: string, body: unknown): Promise<T> {
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

const TOOLS = [
  {
    name: "attest",
    description: "Attest an AI decision to Rubric Protocol (HCS). Returns attestationId.",
    inputSchema: {
      type: "object",
      properties: {
        payload: { type: "string", description: "The AI decision or output to attest." },
        agent_id: { type: "string", description: "Agent identifier (optional)." },
        metadata: { type: "object", description: "Optional key-value metadata.", additionalProperties: true },
      },
      required: ["payload"],
    },
  },
  {
    name: "verify",
    description: "Verify a Rubric attestation by ID. Checks Merkle inclusion and HCS anchoring.",
    inputSchema: {
      type: "object",
      properties: {
        attestation_id: { type: "string", description: "attestationId from a prior attest call." },
      },
      required: ["attestation_id"],
    },
  },
  {
    name: "get_proof",
    description: "Generate a ZK Merkle inclusion proof (Noir/Barretenberg) for an attestation.",
    inputSchema: {
      type: "object",
      properties: {
        attestation_id: { type: "string", description: "attestationId to prove." },
      },
      required: ["attestation_id"],
    },
  },
  {
    name: "register_agent",
    description: "Register an agent and receive a free Rubric developer API key via email.",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Email to receive the API key." },
        agent_name: { type: "string", description: "Name for this agent or project." },
        use_case: { type: "string", description: "Brief use case description (optional)." },
      },
      required: ["email", "agent_name"],
    },
  },
];

async function handleAttest(args: Record<string, unknown>) {
  return rubricPost("/v1/tiered-attest", {
    agentId: (args.agent_id as string) ?? DEFAULT_AGENT_ID,
    sourceId: (args.agent_id as string) ?? DEFAULT_AGENT_ID,
    data: args.payload,
    metadata: (args.metadata as object) ?? { source: "mcp" },
  });
}

async function handleVerify(args: Record<string, unknown>) {
  return rubricPost("/v1/verify", { attestationId: args.attestation_id });
}

async function handleGetProof(args: Record<string, unknown>) {
  return rubricPost("/v1/zk-prove", { attestationId: args.attestation_id });
}

async function handleRegisterAgent(args: Record<string, unknown>) {
  return rubricPost("/v1/keys/request", {
    email: args.email,
    agentName: args.agent_name,
    useCase: args.use_case ?? "",
    source: "mcp-register",
  });
}

const server = new Server(
  { name: "@rubric-protocol/mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;
  try {
    let result: unknown;
    switch (name) {
      case "attest":         result = await handleAttest(a); break;
      case "verify":         result = await handleVerify(a); break;
      case "get_proof":      result = await handleGetProof(a); break;
      case "register_agent": result = await handleRegisterAgent(a); break;
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
  console.error(`[Rubric MCP] ready — ${BASE_URL} / agent: ${DEFAULT_AGENT_ID}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
