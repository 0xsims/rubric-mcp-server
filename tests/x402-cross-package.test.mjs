import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const PR3_COMMIT = "cd157a178a319d1a73aed76dfa28329d7f87e1ae";
const localModule = pathToFileURL(join(import.meta.dirname, "..", "dist", "x402-spend.js")).href;

function compilePr3Module() {
  const root = mkdtempSync(join(tmpdir(), "x402-pr3-src-"));
  const out = mkdtempSync(join(tmpdir(), "x402-pr3-dist-"));
  const shown = spawnSync("git", ["show", `${PR3_COMMIT}:src/x402-spend.ts`], { encoding: "utf8" });
  assert.equal(shown.status, 0, shown.stderr);
  writeFileSync(join(root, "x402-spend.ts"), shown.stdout);
  const compiled = spawnSync(process.execPath, [
    join(import.meta.dirname, "..", "node_modules", "typescript", "lib", "tsc.js"),
    "--pretty", "false",
    "--target", "ES2022",
    "--module", "Node16",
    "--moduleResolution", "Node16",
    "--outDir", out,
    "--rootDir", root,
    "--strict",
    join(root, "x402-spend.ts"),
  ], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  return pathToFileURL(join(out, "x402-spend.js")).href;
}

function reserve(home, moduleUrl, micro) {
  const script = `
    const mod = await import(process.argv[1]);
    const micro = Number(process.argv[2]);
    const reserved = await mod.reserveMicro(micro);
    let spentMicro = null;
    let readError = null;
    try {
      spentMicro = (await mod.readSpend()).spentMicro;
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
    }
    process.stdout.write(JSON.stringify({ reserved, spentMicro, readError }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, moduleUrl, String(micro)], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  return JSON.parse(child.stdout);
}

test("a ledger written by either package is honored by the other", () => {
  const pr3 = compilePr3Module();
  const today = new Date().toISOString().slice(0, 10);

  const fromPr3 = mkdtempSync(join(tmpdir(), "x402-from-pr3-"));
  const wrote = reserve(fromPr3, pr3, 200_000);
  assert.equal(wrote.reserved.ok, true);
  assert.equal(wrote.spentMicro, 200_000);
  const planted = JSON.parse(readFileSync(join(fromPr3, ".rubric", "x402-spend.json"), "utf8"));
  assert.deepEqual(planted, { date: today, spentMicro: 200_000 });
  const tooMuch = reserve(fromPr3, localModule, 100_000);
  assert.equal(tooMuch.reserved.ok, false);
  assert.equal(tooMuch.reserved.error, "DAILY_BUDGET_EXCEEDED");
  assert.equal(tooMuch.spentMicro, 200_000);
  const fits = reserve(fromPr3, localModule, 50_000);
  assert.equal(fits.reserved.ok, true);
  assert.equal(fits.spentMicro, 250_000);

  const fromLocal = mkdtempSync(join(tmpdir(), "x402-from-local-"));
  const localWrote = reserve(fromLocal, localModule, 200_000);
  assert.equal(localWrote.reserved.ok, true);
  assert.equal(localWrote.spentMicro, 200_000);
  const pr3TooMuch = reserve(fromLocal, pr3, 100_000);
  assert.equal(pr3TooMuch.reserved.ok, false);
  assert.equal(pr3TooMuch.reserved.error, "DAILY_BUDGET_EXCEEDED");
  assert.equal(pr3TooMuch.spentMicro, 200_000);
  const pr3Fits = reserve(fromLocal, pr3, 50_000);
  assert.equal(pr3Fits.reserved.ok, true);
  assert.equal(pr3Fits.spentMicro, 250_000);
  const finalLedger = JSON.parse(readFileSync(join(fromLocal, ".rubric", "x402-spend.json"), "utf8"));
  assert.deepEqual(finalLedger, { date: today, spentMicro: 250_000 });
});
