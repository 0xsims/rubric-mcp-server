import { dispatchX402 } from "../dist/x402-tools.js";

const input = JSON.parse(process.argv[2]);
const allowPayments = input.allowPayments !== false;
if (input.parallel) {
  const results = await Promise.all(input.calls.map((call) => dispatchX402(call.name, call.args, { allowPayments })));
  process.stdout.write(JSON.stringify(results));
} else if (input.sequence) {
  const results = [];
  let latestQuoteId = "";
  for (const step of input.sequence) {
    if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    const args = { ...(step.args ?? {}) };
    if (args.quote_id === "$quote") args.quote_id = latestQuoteId;
    const result = await dispatchX402(step.name, args, { allowPayments });
    if (result && typeof result === "object" && typeof result.quoteId === "string") latestQuoteId = result.quoteId;
    results.push(result);
  }
  process.stdout.write(JSON.stringify(results));
} else {
  const result = await dispatchX402(input.name, input.args, { allowPayments });
  process.stdout.write(JSON.stringify(result));
}
