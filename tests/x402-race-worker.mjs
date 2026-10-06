// Child process for the multi-process daily-limit test. Import first, then wait for GO.
import { existsSync, writeFileSync } from "node:fs";

const { dispatchX402 } = await import("../dist/x402-tools.js");
writeFileSync(process.env.READY_FILE, String(process.pid));
const deadline = Date.now() + 20_000;
while (!existsSync(process.env.GO_FILE)) {
  if (Date.now() > deadline) {
    console.error("timed out waiting for GO");
    process.exit(3);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const calls = Number(process.env.CALLS || "4");
const results = await Promise.all(
  Array.from({ length: calls }, () => dispatchX402("hedera_fact", { fact: "supply" })),
);
process.stdout.write(JSON.stringify(results));
