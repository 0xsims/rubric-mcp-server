# @rubric-protocol/mcp-server

Post-quantum AI compliance attestation as an MCP server. Works with Claude Desktop, Claude Code, Cursor, Windsurf, Continue, Zed, and any MCP-compatible host.

**v2.0 — now with free local tier.** No API key required to start attesting.

## Install

    npm install -g @rubric-protocol/mcp-server

## Configure (Claude Desktop)

Edit `claude_desktop_config.json`:

    {
      "mcpServers": {
        "rubric": {
          "command": "npx",
          "args": ["-y", "@rubric-protocol/mcp-server"],
          "env": { "RUBRIC_API_KEY": "optional-for-hcs-anchoring" }
        }
      }
    }

Restart Claude Desktop. Rubric tools appear in the MCP menu.

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

Request a key via the `register_agent` tool, or at https://rubric-protocol.com

### Standard+ tier ($999/mo)
- `compliance_tag` — attach regulatory framework tags to bundles
- `bundle_query` — filter by leafType, agentId, time range
- 100K attestations/mo, overage $0.01 each

### Enterprise ($9,999/mo) / Dedicated ($25K+/mo)
Higher throughput, SLA, dedicated federation capacity.

## Paid evidence tools (x402) - new in 2.2

Six tools that pay per call in USDC on Base via the x402 protocol. No Rubric
account or API key required - just a funded wallet. Every response carries a
signed, Hedera-anchored attestation ID your agent can cite later.

| Tool | Price | What you get |
|---|---|---|
| `screen_entity` | $0.01 | Sanctions/export-control screening across OFAC SDN + Consolidated, UN, UK OFSI, EU, and BIS lists (76K+ entries): per-list results, list file hashes, anchored attestation - audit evidence you screened, against which versions, and what it said |
| `attested_inference` | $0.01 | gpt-4o-mini completion plus attestation binding prompt hash, response hash, exact model version, timestamp - evidence of which model said what, when |
| `agent_record` | $0.005 | Unforgeable operating history for any agent attesting through Rubric - record count, first-seen, continuity - from HCS-anchored records that cannot be backdated |
| `wallet_record` | $0.005 | Attested x402 payment history for any Base/EVM buyer wallet, from an append-only settlement ledger - evidence, not opinion |
| `verify_audit` | $0.002 | Independent audit of any Rubric attestation: signature, HCS sequence, mirror-node confirmation - a signed verdict with its own attestation ID |
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

Catalog, prices, and terms are machine-readable at [x402.json](https://rubric-protocol.com/.well-known/x402.json) and [openapi.json](https://rubric-protocol.com/openapi.json).

## Module configuration

Tools load by module via `RUBRIC_MCP_MODULES` (default: `core,x402`).
Available: `core`, `x402`, `attestation`, `verification`, `compliance`,
`regulatory`, `governance`, `registry`, `ops`, or `all`.

## Regulatory coverage

EU AI Act (Articles 9–15, 17, 26, 49, 72, 73, Annexes IV/XI/XII), SR 11-7, OCC, FDIC, NIST AI RMF 1.0, TX TRAIGA, CO AI Act, HIPAA, EU DSA, NIS2, SEC, CFTC, ECOA Reg B, NYC LL144.

## Tools (50+ across 9 modules)

- `attest` — attest an AI decision (local free, HCS with key)
- `verify` — verify attestation by ID
- `get_proof` — ZK Merkle inclusion proof
- `register_agent` — request free developer API key
- `status` — federation health
- `framework_detect` — auto-detect regulatory frameworks
- `cost_estimate` — monthly cost projection
- `compliance_tag` — attach framework tags (Standard+)
- `bundle_query` — query bundles (Standard+)

## Architecture

- **Post-quantum signatures**: ML-DSA-65 (NIST FIPS 204) via liboqs
- **Merkle aggregation**: N-tier, SHA3-256, up to 1,000,000:1 compression
- **Anchoring**: Hedera mainnet HCS topic 0.0.10416909
- **Federation**: 5 geo-distributed nodes (US, SG, JP, CA, EU)
- **ZK proofs**: Noir beta.19, depth-20 Poseidon2 Merkle inclusion

## Links

- Homepage: https://rubric-protocol.com
- Pricing: https://rubric-protocol.com/pricing
- Status: https://rubric-protocol.com/status
- Changelog: ./CHANGELOG.md
