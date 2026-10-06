# Changelog

## 2.2.4

2.2.3 was not released.

### Security
- x402 payments are signed only for an EIP-3009 USDC `transferWithAuthorization` on Base (`eip155:8453`) to the Rubric payee, with EIP-712 domain `USD Coin` / `2`. Permit2 and any other transfer method are refused before signing. The authorization window is capped at 300 seconds. A zero amount, a non-canonical amount, another network, another asset, or another recipient is refused before signing and is not reserved.
- Each tool's maximum price is enforced on the payment requirements that would actually be signed. A cheaper quote cannot be followed by a higher charge.
- The default daily spend limit is $0.25 (`RUBRIC_X402_DAILY_LIMIT`). An empty value is unset. A value that is not a finite positive decimal falls back to $0.25. It does not mean unlimited.
- The exact amount being signed is reserved before signing, under a cross-process lock held only for the ledger update. The reservation counts for any response once signed, including a non-200. It is released only when signing fails.
- A corrupt, wrong-type, negative, future-dated, or symlinked spend ledger refuses payment. It is never treated as zero.
- Paid requests time out after 30 seconds. A hung call does not block other paid tools in the same process.
- `@x402/core`, `@x402/fetch`, and `@x402/evm` now require `^2.28.0`. `@modelcontextprotocol/sdk` now requires `^1.32.1`.

### Changed
- `repository` is `git+https://github.com/tenprint-ai/tenprint-mcp.git`, `homepage` is `https://tenprint.ai`, and `bugs` is `https://github.com/tenprint-ai/tenprint-mcp/issues`.
- The spend ledger at `~/.rubric/x402-spend.json` is written as `{date, spentMicro}`. A legacy `{date, spentUsd}` file is still read, converted to micro-USDC, and rounded up.
- Do not auto-approve the six paid tools in the MCP client. The wallet key is a plaintext client secret, and the model can trigger a payment.

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
