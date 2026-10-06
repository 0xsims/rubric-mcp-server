import { dispatchX402 } from "../dist/x402-tools.js";

const input = JSON.parse(process.argv[2]);
const allowPayments = input.allowPayments !== false;
if (input.parallel) {
  const results = await Promise.all(input.calls.map((call) => dispatchX402(call.name, call.args, { allowPayments })));
  process.stdout.write(JSON.stringify(results));
} else {
  const result = await dispatchX402(input.name, input.args, { allowPayments });
  process.stdout.write(JSON.stringify(result));
}
