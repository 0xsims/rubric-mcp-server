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

### Setup

1. Create a **dedicated** wallet and fund it with a small amount of USDC on **Base**. Use that wallet only for these tool payments. Do not put `RUBRIC_WALLET_KEY` on a main wallet or any wallet that holds funds you cannot afford to lose.
2. Set `RUBRIC_WALLET_KEY` to that wallet's private key in the MCP client config that launches this server.
3. Optional: `RUBRIC_X402_DAILY_LIMIT` (USD/day). The default is `$0.25`. An empty value is unset and uses that default; it does not mean zero. Optional: `RUBRIC_X402_CONFIRM=1`, described below. It is a speed bump, not a control.

### Before you put a key in a client config

- The private key sits in plaintext in the MCP client config file. Anyone who can read that file can spend the wallet.
- Do not auto-approve the six paid tools (`screen_entity`, `wallet_record`, `agent_record`, `attested_inference`, `hedera_fact`, `verify_audit`) in the MCP client. The client's own per-tool prompt is what asks you before a payment. Auto-approve lets the model spend up to the daily limit without that prompt.
- Prompt injection can ask the client to call a paid tool. With the default settings there is no per-call confirmation, so an injected instruction can spend USDC up to the daily limit.
- `RUBRIC_X402_CONFIRM=1` is a speed bump, not protection. The model sets `confirm` itself, so this does not stop prompt injection and it is not a human approval. The first call returns `confirmationRequired`, a `quoteId`, the tool name, and the tool maximum, and it does not contact the network. A later call pays only when it is the same tool, the same arguments, `confirm: true`, and that `quoteId`. The quote is single use, expires after two minutes (`RUBRIC_X402_CONFIRM_TTL_MS`, default 120000; an empty value keeps that default), and lives only in this process.
- `RUBRIC_BASE_URL` chooses the API host. If it points somewhere else, that host is who this process asks for payment requirements. Keep it on an API you trust.

### What this process enforces

- A payment is signed only for Base (`eip155:8453`, or the v1 network name `base`), asset USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, and payTo `0xaB6731A0BcDf511c2842C768a03448075aB654ca`. The amount must be a positive integer with no leading zeros, at or below that tool's documented maximum. Permit2, a validity window outside 1 to 300 seconds, and an EIP-712 domain other than name `USD Coin` version `2` are refused. The check is on the requirements that would be signed. In confirm mode, that cap is the quoted price.
- The daily limit defaults to `$0.25`. It reserves the exact amount that would be signed, and only once signing starts. If signing does not finish, the reservation is released. An upstream error that comes back with no payment signed does not keep a reservation. Once a payment is signed, it counts toward the limit whatever HTTP status comes back, including a non-200 and a timeout of the paid retry. The counter resets at 00:00 UTC. The ledger file is `~/.rubric/x402-spend.json`. There is no environment variable that moves it.
- No wallet key: the tool returns setup guidance and does not pay.
- Paid responses include `spentTodayUsd`. That number is what this process has reserved, not a promise about charges made outside it.

x402 tools are stdio-only. HTTP mode does not list them, does not call them, and does not sign with `RUBRIC_WALLET_KEY` or `TENPRINT_WALLET_KEY`. An embedded `createMcpServer()` is on that same deny path: it does not sign payments and it does not forward `TENPRINT_API_KEY` or `RUBRIC_API_KEY`. Those turn on only when the caller passes `{ transport: "stdio" }`. The stdio CLI is the only entry in this package that does that.

## Module configuration

Tools load by module via `RUBRIC_MCP_MODULES` (default: `core,x402`).
Available: `core`, `x402`, `attestation`, `verification`, `compliance`,
`regulatory`, `governance`, `registry`, `ops`, or `all`.

A module left out of that list is omitted from `tools/list` and rejected on `tools/call`. HTTP mode also rejects the x402 module even when the list includes `x402` or `all`.

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

The npm bin stays on stdio. Requires Node.js 22 or newer. To serve a remote endpoint:

    HOST=0.0.0.0 PORT=8080 node dist/index.js --http

`PORT` defaults to 3000. `HOST` defaults to `127.0.0.1`. Set `HOST=0.0.0.0` when the process should accept connections from outside the machine. The Docker image sets that.

- `POST /mcp` — MCP Streamable HTTP. `initialize` and `tools/list` need no credentials, so a directory can scan the server. `tools/call` requires a key on that request and otherwise returns HTTP 401 with a JSON-RPC error (`code` -32000, `message` "Unauthorized"). `GET` and `DELETE /mcp` return 405.
- Send the key as `Authorization: Bearer <key>` or `x-api-key: <key>`. That request key is what is sent upstream as `x-api-key`. `TENPRINT_API_KEY` and `RUBRIC_API_KEY` apply to stdio only. They do not authorize HTTP `tools/call`, so a hosted process cannot spend its own key for an anonymous caller.
- x402 paid tools are not listed or callable whenever the HTTP server is running, including when `startHttpServer` is imported directly. `RUBRIC_MCP_MODULES` does not turn them back on. `RUBRIC_WALLET_KEY` and `TENPRINT_WALLET_KEY` are not used to sign or pay.
- Requests with no `Origin` are accepted. A request that sends `Origin` is rejected unless that value is listed in `TENPRINT_ALLOWED_ORIGINS` (comma-separated). `Host` must be `localhost`, `127.0.0.1`, `::1`, or `[::1]` (including `[::1]:port`), or a value listed in `TENPRINT_ALLOWED_HOSTS`. Set the public hostname there when a reverse proxy forwards one. The server does not send `Access-Control-Allow-Origin: *`.
- Request bodies are limited to 1 MB. `/mcp` is rate limited per socket address and per API key (default 120 requests per minute, `TENPRINT_RATE_LIMIT_PER_MINUTE`). `TENPRINT_TRUSTED_PROXY` is off by default, so `X-Forwarded-For` is ignored and every caller behind one proxy shares the proxy's bucket. Set it to `1` only when every connection comes from a reverse proxy you trust; the bucket then uses the last `X-Forwarded-For` hop, the address that proxy appended. A comma-separated list trusts only those proxy addresses. Idle buckets are dropped, and the table is capped at `TENPRINT_RATE_BUCKET_CAP` (default 4096).
- `GET /health` — `{ "status": "ok" }`
- `GET /.well-known/mcp/server-card.json` — server card. Its `tools` array is the same list `tools/list` returns for this process. `authentication.required` is true because `tools/call` requires a key. `initialize` and `tools/list` stay open.

## Docker

The image runs the HTTP transport, not stdio, and listens on `0.0.0.0`. `RUBRIC_MCP_MODULES` in the image is `core`. x402 tools stay off in HTTP mode even if that variable includes them. The image runs as the `node` user. Set `TENPRINT_ALLOWED_HOSTS` to the public hostname if clients send that `Host` header.

    docker build -t tenprint-mcp .
    docker run --rm -p 8080:8080 tenprint-mcp

`POST http://127.0.0.1:8080/mcp` then serves `initialize` and `tools/list` with no key. `tools/call` needs `Authorization: Bearer <key>` or `x-api-key` on the request. Setting `TENPRINT_API_KEY` on the container does not open `tools/call`.

## Not published yet

- **License.** The owner has not chosen one. There is no `LICENSE` file. `package.json` still says `SEE LICENSE IN LICENSE`. Do not treat this package as licensed for reuse until that file exists.
- **Repository and registry.** The names below are the intended ones after transfer. `github.com/tenprint-ai/tenprint-mcp` does not exist yet. `ai.tenprint/tenprint` still needs DNS or HTTP proof for the MCP registry, and `@tenprint/mcp-server` is not published. Do not treat those URLs as live.

## Links

- Homepage: https://tenprint.ai
- Repository (intended, not created yet): https://github.com/tenprint-ai/tenprint-mcp
- Issues (intended, not created yet): https://github.com/tenprint-ai/tenprint-mcp/issues
- Changelog: ./CHANGELOG.md
