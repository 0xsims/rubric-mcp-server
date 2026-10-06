# Changelog

## 2.3.0

### Added
- Streamable HTTP transport via `node dist/index.js --http` (stdio stays the default for the npm bin)
- `POST /mcp`, `GET /health`, and `GET /.well-known/mcp/server-card.json`
- HTTP `tools/call` requires `Authorization: Bearer <key>` or an `x-api-key` header on the request. `TENPRINT_API_KEY` / `RUBRIC_API_KEY` authorize stdio only, not HTTP `tools/call`. `initialize` and `tools/list` do not require a key
- HTTP mode disables the x402 module. Those tools are omitted from `tools/list` and the server card, and `tools/call` refuses them. `RUBRIC_WALLET_KEY` and `TENPRINT_WALLET_KEY` are not used to sign or pay. stdio is unchanged
- Dockerfile that runs HTTP mode, `glama.json`, and official MCP registry `server.json` (`ai.tenprint/tenprint`, npm `@tenprint/mcp-server` 2.3.0, remote `https://mcp.tenprint.ai/mcp`)

### Changed
- Package renamed to `@tenprint/mcp-server` (bin `tenprint-mcp`; `rubric-mcp` kept as an alias)
- Server name shown to clients is TenPrint
- API key environment variable is `TENPRINT_API_KEY`. `RUBRIC_API_KEY` still works and logs a deprecation warning

### Unchanged
- x402 paid tools and the rest of the 2.2.2 tool surface
- Default API base URL remains `https://rubric-protocol.com` via `RUBRIC_BASE_URL`

## 2.0.1

### Fixed
- `verify` tool: corrected to `GET /v1/verify/:id` (was incorrectly sending POST with body, returning 404 for all calls in 1.x and 2.0.0)
- `get_proof` tool: friendly error for tier-1 buffered attestations awaiting Merkle flush, instead of raw circuit 500
- Removed `compliance_tag` tool — endpoint not yet implemented on federation, will return in a future release

### Unchanged
- All other 2.0.0 functionality — local attestation, framework_detect, cost_estimate, bundle_query, status, register_agent, HCS-anchored attest


## 2.0.0

### Added
- Free local-only tier — `attest` now works without `RUBRIC_API_KEY`, writing PQ-signed Merkle leaves to `~/.rubric/local-bundles/`
- `status` tool — federation health across US/SG/JP/CA/EU nodes
- `framework_detect` tool — auto-detect regulatory frameworks (EU AI Act, SR 11-7, HIPAA, NIST AI RMF, NYC LL144, CO AI Act, EU DSA, NIS2, SEC, CFTC, ECOA Reg B) from decision content. Works offline.
- `cost_estimate` tool — monthly Rubric cost projection from decision volume
- `compliance_tag` tool — attach framework tags to bundles (Standard+ tier)
- `bundle_query` tool — filter attestations by leafType, agentId, time range (Standard+ tier)

### Changed
- **BREAKING**: `attest` no longer exits on missing `RUBRIC_API_KEY`. Falls back to local mode with a clear stderr warning. Existing 1.x users with keys configured are unaffected.
- Server name/version in handshake updated to 2.0.0
- `verify` checks local store first when running in local mode

### Preserved (unchanged from 1.x)
- `attest`, `verify`, `get_proof`, `register_agent` tool contracts
- API endpoints: `/v1/tiered-attest`, `/v1/verify`, `/v1/zk-prove`, `/v1/keys/request`
- Field mappings: `payload → data`, `agent_id → agentId/sourceId`, `attestation_id → attestationId`

### Migration from 1.x
No action required if you have `RUBRIC_API_KEY` set. All 1.x tool calls work identically. New free tier activates automatically if key is absent.

## 1.0.2
- Initial public release — attest, verify, get_proof, register_agent
