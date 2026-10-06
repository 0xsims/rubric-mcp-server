# TenPrint MCP Server

Post-quantum AI compliance attestation as an MCP server. Works with Claude Desktop, Claude Code, Cursor, Windsurf, Continue, Zed, and any MCP-compatible host.

Package: `@tenprint/mcp-server`. The `tenprint-mcp` binary is the primary command. `rubric-mcp` remains installed as an alias.

## Install

    npm install -g @tenprint/mcp-server

## Configure (Claude Desktop)

Edit `claude_desktop_config.json`:

    {
      "mcpServers": {
        "tenprint": {
          "command": "npx",
          "args": ["-y", "@tenprint/mcp-server"],
          "env": { "TENPRINT_API_KEY": "optional-for-hcs-anchoring" }
        }
      }
    }

`RUBRIC_API_KEY` is still accepted. If it is set and `TENPRINT_API_KEY` is not, the server logs a deprecation warning and uses the old value.

Restart Claude Desktop. TenPrint tools appear in the MCP menu.

API calls still use `RUBRIC_BASE_URL` (default `https://rubric-protocol.com`). This package does not switch that host on its own.

## Tiers

### Free (no key)
- `attest` — PQ-signed Merkle leaves stored in `~/.rubric/local-bundles/`
- `verify` — check local attestations
- `framework_detect` — detect applicable regulations offline
- `cost_estimate` — project monthly cost
- `register_agent` — request a free key to unlock HCS anchoring
- `status` — federation health

### With API key (free developer tier)
Everything above, plus:
- HCS anchoring on Hedera mainnet (tamper-evident third-party timestamp)
- `get_proof` — ZK Merkle inclusion proofs (Noir/Barretenberg)

Request a key via the `register_agent` tool. The product site is https://tenprint.ai.

### Standard+ tier ($999/mo)
- `bundle_query` — filter by leafType, agentId, time range
- 100K attestations/mo, overage $0.01 each

### Enterprise ($9,999/mo) / Dedicated ($25K+/mo)
Higher throughput, SLA, dedicated federation capacity.

## Paid evidence tools (x402)

Six tools that pay per call in USDC on Base via the x402 protocol. No TenPrint account or API key required on stdio — just a funded wallet. Every response carries a signed, Hedera-anchored attestation ID your agent can cite later.

| Tool | Price | What you get |
|---|---|---|
| `screen_entity` | $0.01 | Sanctions/export-control screening across OFAC SDN + Consolidated, UN, UK OFSI, EU, and BIS lists (76K+ entries): per-list results, list file hashes, anchored attestation - audit evidence you screened, against which versions, and what it said |
| `attested_inference` | $0.01 | gpt-4o-mini completion plus attestation binding prompt hash, response hash, exact model version, timestamp - evidence of which model said what, when |
| `agent_record` | $0.005 | Unforgeable operating history for any agent attesting through TenPrint - record count, first-seen, continuity - from HCS-anchored records that cannot be backdated |
| `wallet_record` | $0.005 | Attested x402 payment history for any Base/EVM buyer wallet, from an append-only settlement ledger - evidence, not opinion |
| `verify_audit` | $0.002 | Independent audit of any TenPrint attestation: signature, HCS sequence, mirror-node confirmation - a signed verdict with its own attestation ID |
| `hedera_fact` | $0.001 | One attested Hedera network fact (exchange rate, gas, supply, nodes, throughput, topic state) |

### Setup (3 steps)

1. Create a wallet and fund it with a few dollars of USDC on **Base** (Coinbase -> withdraw USDC -> network: Base)
2. Set `RUBRIC_WALLET_KEY` to the wallet's private key in your MCP server environment
3. Optional: `RUBRIC_X402_DAILY_LIMIT` (default `1.00` USD/day)

### Money safety, by design

- **No wallet key?** Paid tools return setup guidance - never errors, never charges.
- **Daily ceiling.** Spending stops at your limit; the tool returns a budget error your agent can read. Resets 00:00 UTC.
- **Price protection.** Before paying, each tool checks the server's quoted price against its documented maximum and refuses anything higher - even we cannot overcharge you.
- **Full accounting.** Every paid response includes `spentTodayUsd`.
- Your key never leaves the MCP process. A failed operation is never charged.

## Module configuration

Tools load by module via `RUBRIC_MCP_MODULES` (default: `core,x402`).
Available: `core`, `x402`, `attestation`, `verification`, `compliance`,
`regulatory`, `governance`, `registry`, `ops`, or `all`.

## Regulatory coverage

EU AI Act (Articles 9–15, 17, 26, 49, 72, 73, Annexes IV/XI/XII), SR 11-7, OCC, FDIC, NIST AI RMF 1.0, TX TRAIGA, CO AI Act, HIPAA, EU DSA, NIS2, SEC, CFTC, ECOA Reg B, NYC LL144.

## Tools (53 across 9 modules)

Default profile is `core` plus `x402`. Set `RUBRIC_MCP_MODULES=all` for the rest.

**core:** attest, verify, get_proof, register_agent, status, framework_detect, cost_estimate, bundle_query

**x402:** screen_entity, wallet_record, agent_record, attested_inference, hedera_fact, verify_audit

**attestation:** attest_batch, attestation_status, attestation_get, pipeline_trace, bundle_get

**verification:** verify_chain, verify_tree, verify_batch, zk_verify, zk_proof_get, ledger_lookup

**compliance:** annex4_generate, annex4_status, c2pa_attest, c2pa_assertion, credential_issue, credential_get, compliance_query, compliance_report, filing_generate

**regulatory:** gpai_register, gpai_downstream, nist_rmf_certify, nist_rmf_status, jurisdiction_map, jurisdiction_assess, jurisdiction_gap

**governance:** incident_create, incident_attest, incident_resolve, human_review, adversarial_session_start, adversarial_session_conclude

**registry:** agent_add, agent_get, model_register, model_get

**ops:** usage_report, auditor_token_create

## Architecture

- **Post-quantum signatures**: ML-DSA-65 (NIST FIPS 204) via liboqs
- **Merkle aggregation**: N-tier, SHA3-256, up to 1,000,000:1 compression
- **Anchoring**: Hedera mainnet HCS topic 0.0.10416909
- **Federation**: 5 geo-distributed nodes (US, SG, JP, CA, EU)
- **ZK proofs**: Noir beta.19, depth-20 Poseidon2 Merkle inclusion

## Streamable HTTP

The npm bin stays on stdio. To serve a remote endpoint:

    PORT=8080 node dist/index.js --http

`PORT` defaults to 3000.

- `POST /mcp` — MCP Streamable HTTP. `initialize` and `tools/list` need no credentials, so a directory can scan the server. `tools/call` requires a key on that request and otherwise returns HTTP 401 with a JSON-RPC error (`code` -32000, `message` "Unauthorized").
- Send the key as `Authorization: Bearer <key>` or `x-api-key: <key>`. That request key is what is sent upstream as `x-api-key`. `TENPRINT_API_KEY` and `RUBRIC_API_KEY` apply to stdio only. They do not authorize HTTP `tools/call`, so a hosted process cannot spend its own key for an anonymous caller.
- x402 paid tools are not listed or callable in HTTP mode, even if `RUBRIC_MCP_MODULES` includes `x402` or `all`. A `RUBRIC_WALLET_KEY` or `TENPRINT_WALLET_KEY` on the process is not used to sign or pay. stdio is unchanged.
- `GET /health` — `{ "status": "ok" }`
- `GET /.well-known/mcp/server-card.json` — server card. Its `tools` array is the same list `tools/list` returns for this process.

## Docker

The image runs the HTTP transport, not stdio. `RUBRIC_MCP_MODULES` in the image is `core`. x402 tools stay off in HTTP mode even if that variable includes them.

    docker build -t tenprint-mcp .
    docker run --rm -p 8080:8080 tenprint-mcp

`POST http://127.0.0.1:8080/mcp` then serves `initialize` and `tools/list` with no key. `tools/call` needs `Authorization: Bearer <key>` or `x-api-key` on the request. Setting `TENPRINT_API_KEY` on the container does not open `tools/call`.

## Links

- Homepage: https://tenprint.ai
- Repository: https://github.com/tenprint-ai/tenprint-mcp
- Issues: https://github.com/tenprint-ai/tenprint-mcp/issues
- Changelog: ./CHANGELOG.md
