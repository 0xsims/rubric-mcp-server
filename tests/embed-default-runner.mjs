import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/index.js";

async function session(server) {
  const client = new Client({ name: "embed-default-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

const embedded = await session(createMcpServer());
const optedIn = await session(createMcpServer({ transport: "stdio" }));

const embeddedTools = await embedded.listTools();
const screen = await embedded.callTool({ name: "screen_entity", arguments: { name: "example" } });
const embeddedStatus = await embedded.callTool({ name: "status", arguments: {} });
const optedTools = await optedIn.listTools();
const optedStatus = await optedIn.callTool({ name: "status", arguments: {} });

process.stdout.write(JSON.stringify({
  embeddedTools: embeddedTools.tools.map((tool) => tool.name),
  optedTools: optedTools.tools.map((tool) => tool.name),
  screen,
  embeddedStatus,
  optedStatus,
}));
