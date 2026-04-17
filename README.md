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

attest - PQ-signed, HCS-anchored decision record (requires key)
verify - Verify an attestation by ID
get_proof - ZK Merkle inclusion proof (requires key)
register_agent - Get a free API key via email
framework_detect - Map regulatory frameworks from decision content
status - Federation health across 5 global nodes
cost_estimate - Estimate monthly cost from decision volume
bundle_query - Query attestation bundles (requires key)

## Get a Free API Key

Run register_agent directly inside Claude Desktop, no browser required.
Or visit https://rubric-protocol.com

## Regulatory Coverage

EU AI Act | SR 11-7 | NIST AI RMF | HIPAA | NYC Local Law 144 | ECOA Reg B

## Links

https://rubric-protocol.com
https://www.npmjs.com/package/@rubric-protocol/mcp-server
https://registry.modelcontextprotocol.io
