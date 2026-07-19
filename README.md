# Rubric Protocol MCP Server

AI compliance attestation for Claude Desktop, Cursor, Windsurf, and any MCP-compatible host.

Every AI decision PQ-signed, Merkle-chained, and anchored to Hedera mainnet. Built for EU AI Act Article 12, SR 11-7, HIPAA, and NIST AI RMF.

## Quickstart

Add to your claude_desktop_config.json:

    {
      "mcpServers": {
        "rubric": {
          "command": "npx",
          "args": ["-y", "@rubric-protocol/mcp-server@latest"],
          "env": {
            "RUBRIC_API_KEY": "your-key-here"
          }
        }
      }
    }

Free local tier, no key required:

    {
      "mcpServers": {
        "rubric": {
          "command": "npx",
          "args": ["-y", "@rubric-protocol/mcp-server@latest"]
        }
      }
    }

Restart Claude Desktop. Rubric tools appear automatically.

## Tools

47 tools across 8 modules. Default profile exposes the core 8; set `RUBRIC_MCP_MODULES=all` (or a comma list, e.g. `core,compliance`) for more.

**core (default):** attest, verify, get_proof, register_agent, status, framework_detect, cost_estimate, bundle_query
**attestation:** attest_batch, attestation_status, attestation_get, pipeline_trace, bundle_get
**verification:** verify_chain, verify_tree, verify_batch, zk_verify, zk_proof_get, ledger_lookup
**compliance:** annex4_generate, annex4_status, c2pa_attest, c2pa_assertion, credential_issue, credential_get, compliance_query, compliance_report, filing_generate
**regulatory:** gpai_register, gpai_downstream, nist_rmf_certify, nist_rmf_status, jurisdiction_map, jurisdiction_assess, jurisdiction_gap
**governance:** incident_create, incident_attest, incident_resolve, human_review, adversarial_session_start, adversarial_session_conclude
**registry:** agent_add, agent_get, model_register, model_get
**ops:** usage_report, auditor_token_create

The only MCP tools whose outputs are ML-DSA-65 (FIPS 204) signed, Hedera-anchored, and exportable as EU AI Act Annex IV, OSCAL, C2PA, and W3C Verifiable Credential evidence.

## Get a Free API Key

Run register_agent directly inside Claude Desktop, no browser required.
Or visit https://rubric-protocol.com

## Regulatory Coverage

EU AI Act | SR 11-7 | NIST AI RMF | HIPAA | NYC Local Law 144 | ECOA Reg B

## Links

https://rubric-protocol.com
https://www.npmjs.com/package/@rubric-protocol/mcp-server
https://registry.modelcontextprotocol.io
