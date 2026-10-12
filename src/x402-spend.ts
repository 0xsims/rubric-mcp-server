// Shared x402 spend ledger. Copied verbatim by later packages; no package-specific imports.
//
// Ledger path (fixed, no env override): ~/.rubric/x402-spend.json
// Directory mode 0700. Ledger mode 0600.
// Written format: {"date":"YYYY-MM-DD","spentMicro":<non-negative integer>}
//   spentMicro is USDC atomic units (6 decimals).
// Legacy read: {"date":"YYYY-MM-DD","spentUsd":<non-negative finite number>}
//   converted to micro-USDC and rounded UP. A later write replaces it with spentMicro.
// Date is the UTC calendar day from new Date().toISOString().slice(0, 10), the same
// convention as @rubric-protocol/mcp-server 2.2.2. A valid earlier day resets to 0.
// A missing file is 0. A symlink, a non-file, corrupt JSON, a bad date, a wrong type,
// or a negative amount refuses payment. It is never treated as 0.
//
// Lock protocol: ~/.rubric/x402-spend.json.lock opened with O_EXCL ("wx").
// The file contains the holder PID. Waiters sleep asynchronously (they do not block
// the event loop). A waiter replaces the lock only when the PID is dead or the lock
// mtime is older than 15s, and only if the contents still match what it read.
// The same 15s bound is the wait timeout. The lock is held only around the
// read-modify-write. It is not held during HTTP. That one lock serializes both
// in-process and cross-process reservations.
//
// Each process applies its own RUBRIC_X402_DAILY_LIMIT to this shared counter.
// A process with a higher limit can spend past another process's limit.
// Unset, empty, or an invalid limit falls back to $0.25. It does not mean unlimited.
//
// Payment checks run before signing. A requirement that fails them is not signed
// and not reserved. Once a signature is created, the reservation stays for any
// HTTP outcome, including non-200 and a timeout of the paid retry. It is released
// only from onPaymentCreationFailure (signing did not finish).
//
// Authorization window: maxTimeoutSeconds must be an integer from 1 through 300.
// The signer sets validBefore to now + maxTimeoutSeconds, so this is a 5 minute cap
// (the bound from the 2.2.4 review). EIP-712 domain must be Base USDC
// (name "USD Coin", version "2"). Amounts must match /^[1-9]\d*$/.

import { AsyncLocalStorage } from "async_hooks";
import { randomBytes } from "crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const BASE_NETWORK = "eip155:8453" as const;
export const BASE_NETWORK_V1 = "base";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const PAY_TO = "0xaB6731A0BcDf511c2842C768a03448075aB654ca";
export const USDC_EIP712_NAME = "USD Coin";
export const USDC_EIP712_VERSION = "2";
export const MAX_AUTH_WINDOW_SECONDS = 300;
export const DEFAULT_DAILY_LIMIT_USD = 0.25;
export const DEFAULT_DAILY_LIMIT_MICRO = 250_000;
export const DEFAULT_PAYMENT_TIMEOUT_MS = 30_000;
export const MAX_DAILY_LIMIT_MICRO = 10_000_000_000; // $10,000

/** Tool maximums in USDC atomic units (6 decimals). */
export const TOOL_MAX_MICRO: Record<string, number> = {
  screen_entity: 10_000,
  wallet_record: 5_000,
  agent_record: 5_000,
  attested_inference: 10_000,
  hedera_fact: 1_000,
  verify_audit: 2_000,
};

export const AMOUNT_RE = /^[1-9]\d*$/;
export const LIMIT_RE = /^\d+(\.\d{1,6})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const LOCK_WAIT_MS = 15_000;

export class SpendLedgerError extends Error {
  readonly code: "LEDGER_INVALID" | "LEDGER_SYMLINK" | "LEDGER_LOCK_TIMEOUT";
  constructor(code: SpendLedgerError["code"], message: string) {
    super(message);
    this.name = "SpendLedgerError";
    this.code = code;
  }
}

export interface SpendState {
  date: string;
  spentMicro: number;
}

export interface PaymentRequirement {
  scheme?: string;
  network?: string;
  asset?: string;
  payTo?: string;
  amount?: string | number;
  maxAmountRequired?: string | number;
  maxTimeoutSeconds?: number;
  extra?: { name?: unknown; version?: unknown; assetTransferMethod?: unknown };
}

export type ReserveResult =
  | { ok: true; spentMicro: number; limitMicro: number; date: string }
  | { ok: false; error: "DAILY_BUDGET_EXCEEDED" | "LEDGER_INVALID" | "LEDGER_SYMLINK" | "LEDGER_LOCK_TIMEOUT"; spentMicro: number; limitMicro: number; date: string; message: string };

export function spendDirectory(): string {
  return join(homedir(), ".rubric");
}

export function spendFilePath(): string {
  return join(spendDirectory(), "x402-spend.json");
}

export function spendLockPath(): string {
  return spendFilePath() + ".lock";
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function microToUsd(micro: number): number {
  return micro / 1e6;
}

export function microToMoney(micro: number): string {
  const whole = Math.trunc(micro / 1_000_000);
  const frac = String(Math.abs(micro % 1_000_000)).padStart(6, "0").replace(/0+$/, "");
  return frac.length > 0 ? `$${whole}.${frac}` : `$${whole}`;
}

/** Round a legacy USD amount up to micro-USDC. Rejects non-finite and negative values. */
export function usdToMicroCeil(usd: number): number {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
    throw new SpendLedgerError("LEDGER_INVALID", "Spend ledger spentUsd must be a non-negative finite number. Inspect or delete ~/.rubric/x402-spend.json. No payment was made.");
  }
  const fixed = usd.toFixed(8);
  if (/[eE]/.test(fixed)) {
    throw new SpendLedgerError("LEDGER_INVALID", "Spend ledger spentUsd is too large to convert. Inspect or delete ~/.rubric/x402-spend.json. No payment was made.");
  }
  const [whole, frac = ""] = fixed.split(".");
  const padded = (frac + "00000000").slice(0, 8);
  const micro = Number(whole) * 1_000_000 + Number(padded.slice(0, 6));
  const rounded = /[1-9]/.test(padded.slice(6)) ? micro + 1 : micro;
  if (!Number.isSafeInteger(rounded)) {
    throw new SpendLedgerError("LEDGER_INVALID", "Spend ledger spentUsd is too large to convert. Inspect or delete ~/.rubric/x402-spend.json. No payment was made.");
  }
  return rounded;
}

export function parseDailyLimitMicro(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_DAILY_LIMIT_MICRO;
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_DAILY_LIMIT_MICRO;
  if (!LIMIT_RE.test(trimmed)) return DEFAULT_DAILY_LIMIT_MICRO;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_DAILY_LIMIT_MICRO;
  const [whole, frac = ""] = trimmed.split(".");
  const micro = Number(whole) * 1_000_000 + Number((frac + "000000").slice(0, 6));
  if (!Number.isSafeInteger(micro) || micro <= 0 || micro > MAX_DAILY_LIMIT_MICRO) return DEFAULT_DAILY_LIMIT_MICRO;
  return micro;
}

export function dailyLimitMicro(): number {
  return parseDailyLimitMicro(process.env.RUBRIC_X402_DAILY_LIMIT);
}

function isUtcDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function ledgerMessage(detail: string): string {
  return `${detail} Inspect or delete ~/.rubric/x402-spend.json. No payment was made.`;
}

function readAmount(rec: Record<string, unknown>): number {
  if ("spentMicro" in rec && rec.spentMicro !== undefined) {
    const micro = rec.spentMicro;
    if (typeof micro !== "number" || !Number.isSafeInteger(micro) || micro < 0) {
      throw new SpendLedgerError("LEDGER_INVALID", ledgerMessage("Spend ledger spentMicro must be a non-negative integer."));
    }
    return micro;
  }
  if ("spentUsd" in rec && rec.spentUsd !== undefined) return usdToMicroCeil(rec.spentUsd as number);
  throw new SpendLedgerError("LEDGER_INVALID", ledgerMessage("Spend ledger has neither spentMicro nor spentUsd."));
}

function parseLedger(value: unknown, today: string): SpendState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SpendLedgerError("LEDGER_INVALID", ledgerMessage("Spend ledger must be a JSON object."));
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.date !== "string" || !isUtcDate(rec.date)) {
    throw new SpendLedgerError("LEDGER_INVALID", ledgerMessage("Spend ledger date must be YYYY-MM-DD."));
  }
  if (rec.date > today) {
    throw new SpendLedgerError("LEDGER_INVALID", ledgerMessage("Spend ledger date is in the future."));
  }
  const spentMicro = readAmount(rec);
  if (rec.date < today) return { date: today, spentMicro: 0 };
  return { date: today, spentMicro };
}

function ensureSpendDir(): void {
  const dir = spendDirectory();
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) {
      throw new SpendLedgerError("LEDGER_SYMLINK", "The ~/.rubric directory is a symlink. No payment was made.");
    }
    if (!st.isDirectory()) {
      throw new SpendLedgerError("LEDGER_INVALID", ledgerMessage("The ~/.rubric path is not a directory."));
    }
  } catch (err) {
    if (err instanceof SpendLedgerError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const created = lstatSync(dir);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new SpendLedgerError("LEDGER_SYMLINK", "The ~/.rubric directory is a symlink. No payment was made.");
    }
  }
  chmodSync(dir, 0o700);
}

function rejectSpecialFile(path: string, label: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new SpendLedgerError("LEDGER_SYMLINK", `The ${label} is a symlink. No payment was made.`);
  }
  if (!st.isFile()) {
    throw new SpendLedgerError("LEDGER_INVALID", ledgerMessage(`The ${label} is not a regular file.`));
  }
}

function readLedgerUnlocked(): SpendState {
  const file = spendFilePath();
  let st;
  try {
    st = lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { date: todayUtc(), spentMicro: 0 };
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new SpendLedgerError("LEDGER_SYMLINK", "The spend ledger is a symlink. No payment was made.");
  }
  if (!st.isFile()) {
    throw new SpendLedgerError("LEDGER_INVALID", ledgerMessage("The spend ledger is not a regular file."));
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new SpendLedgerError("LEDGER_INVALID", ledgerMessage("The spend ledger could not be read."));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SpendLedgerError("LEDGER_INVALID", ledgerMessage("The spend ledger is not valid JSON."));
  }
  return parseLedger(parsed, todayUtc());
}

function writeLedgerUnlocked(state: SpendState): void {
  ensureSpendDir();
  const file = spendFilePath();
  rejectSpecialFile(file, "spend ledger");
  const tmp = join(spendDirectory(), `.x402-spend.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  rejectSpecialFile(tmp, "temporary spend file");
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ date: state.date, spentMicro: state.spentMicro }));
  } finally {
    closeSync(fd);
  }
  const written = lstatSync(tmp);
  if (written.isSymbolicLink() || !written.isFile()) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw new SpendLedgerError("LEDGER_SYMLINK", "The temporary spend file is a symlink. No payment was made.");
  }
  chmodSync(tmp, 0o600);
  try {
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  chmodSync(file, 0o600);
}

function pidAlive(pidText: string): boolean {
  const pid = Number(pidText.trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireSpendLock(): Promise<void> {
  ensureSpendDir();
  const lock = spendLockPath();
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let contents = "";
      let mtimeMs = 0;
      try {
        const st = lstatSync(lock);
        if (st.isSymbolicLink()) {
          throw new SpendLedgerError("LEDGER_SYMLINK", "The spend lock is a symlink. No payment was made.");
        }
        contents = readFileSync(lock, "utf8");
        mtimeMs = st.mtimeMs;
      } catch (readErr) {
        if (readErr instanceof SpendLedgerError) throw readErr;
        if ((readErr as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readErr;
      }
      const stale = Date.now() - mtimeMs > LOCK_WAIT_MS || !pidAlive(contents);
      if (stale) {
        let again = "";
        try { again = readFileSync(lock, "utf8"); } catch { again = "\0"; }
        if (again === contents) {
          try { unlinkSync(lock); } catch { /* another waiter took it */ }
          continue;
        }
      }
      if (Date.now() - start > LOCK_WAIT_MS) {
        throw new SpendLedgerError("LEDGER_LOCK_TIMEOUT", "Timed out waiting for the x402 spend lock. No payment was made.");
      }
      await sleep(20);
    }
  }
}

function releaseSpendLock(): void {
  const lock = spendLockPath();
  try {
    const st = lstatSync(lock);
    if (st.isSymbolicLink()) return;
    if (readFileSync(lock, "utf8").trim() === String(process.pid)) unlinkSync(lock);
  } catch { /* already gone */ }
}

async function withLedgerLock<T>(fn: () => T): Promise<T> {
  await acquireSpendLock();
  try {
    return fn();
  } finally {
    releaseSpendLock();
  }
}

export async function readSpend(): Promise<SpendState> {
  return withLedgerLock(() => readLedgerUnlocked());
}

export async function reserveMicro(micro: number): Promise<ReserveResult> {
  try {
    return await withLedgerLock(() => {
      const limitMicro = dailyLimitMicro();
      const state = readLedgerUnlocked();
      if (!Number.isSafeInteger(micro) || micro <= 0) {
        return { ok: false as const, error: "LEDGER_INVALID" as const, spentMicro: state.spentMicro, limitMicro, date: state.date, message: "Refusing to reserve a non-positive amount. No payment was made." };
      }
      if (state.spentMicro + micro > limitMicro) {
        return { ok: false as const, error: "DAILY_BUDGET_EXCEEDED" as const, spentMicro: state.spentMicro, limitMicro, date: state.date, message: "Raise RUBRIC_X402_DAILY_LIMIT or retry after 00:00 UTC. No payment was made." };
      }
      const next = { date: todayUtc(), spentMicro: state.spentMicro + micro };
      writeLedgerUnlocked(next);
      return { ok: true as const, spentMicro: next.spentMicro, limitMicro, date: next.date };
    });
  } catch (err) {
    if (err instanceof SpendLedgerError) {
      return { ok: false, error: err.code, spentMicro: 0, limitMicro: dailyLimitMicro(), date: todayUtc(), message: err.message };
    }
    throw err;
  }
}

export async function releaseMicro(micro: number, date: string): Promise<number> {
  return withLedgerLock(() => {
    const state = readLedgerUnlocked();
    if (state.date === date) {
      state.spentMicro = Math.max(0, state.spentMicro - micro);
      writeLedgerUnlocked(state);
    }
    return state.spentMicro;
  });
}

export function requirementAtomic(version: number, req: PaymentRequirement): bigint | null {
  const raw = version === 1 ? req.maxAmountRequired : req.amount;
  if (typeof raw !== "string" || !AMOUNT_RE.test(raw)) return null;
  try {
    const atomic = BigInt(raw);
    return atomic > 0n ? atomic : null;
  } catch {
    return null;
  }
}

export function requirementAllowed(version: number, req: PaymentRequirement, maxAtomic: bigint, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  void nowSeconds;
  if (req.scheme !== "exact") return false;
  if (req.network !== BASE_NETWORK && req.network !== BASE_NETWORK_V1) return false;
  if ((req.asset ?? "").toLowerCase() !== USDC_BASE.toLowerCase()) return false;
  if ((req.payTo ?? "").toLowerCase() !== PAY_TO.toLowerCase()) return false;
  const method = req.extra?.assetTransferMethod ?? "eip3009";
  if (method !== "eip3009") return false;
  if (req.extra?.name !== USDC_EIP712_NAME || req.extra?.version !== USDC_EIP712_VERSION) return false;
  if (typeof req.maxTimeoutSeconds !== "number" || !Number.isInteger(req.maxTimeoutSeconds)) return false;
  if (req.maxTimeoutSeconds < 1 || req.maxTimeoutSeconds > MAX_AUTH_WINDOW_SECONDS) return false;
  const atomic = requirementAtomic(version, req);
  return atomic !== null && atomic <= maxAtomic;
}

export function fetchWithTimeout(baseFetch: typeof fetch = fetch, timeoutMs = DEFAULT_PAYMENT_TIMEOUT_MS): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException(`x402 payment timed out after ${timeoutMs}ms`, "TimeoutError"));
    }, timeoutMs);
    const outer = init?.signal;
    const onOuter = () => controller.abort(outer?.reason);
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener("abort", onOuter, { once: true });
    }
    try {
      return await baseFetch(input, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted && controller.signal.reason) throw controller.signal.reason;
      throw err;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    }
  };
}

interface SpendContext {
  pending: { micro: number; date: string } | null;
}

const spendContext = new AsyncLocalStorage<SpendContext>();

export function runWithSpendContext<T>(fn: () => Promise<T>): Promise<T> {
  return spendContext.run({ pending: null }, fn);
}

export function attachSpendHooks(client: {
  onBeforePaymentCreation(hook: (ctx: { paymentRequired: { x402Version: number }; selectedRequirements: PaymentRequirement }) => Promise<void | { abort: true; reason: string }>): unknown;
  onPaymentCreationFailure(hook: () => Promise<void>): unknown;
}, maxAtomic: bigint): void {
  client.onBeforePaymentCreation(async (ctx) => {
    const store = spendContext.getStore();
    if (!store) return { abort: true, reason: "LEDGER_INVALID: spend context missing. No payment was made." };
    const version = ctx.paymentRequired.x402Version;
    if (!requirementAllowed(version, ctx.selectedRequirements, maxAtomic)) {
      return { abort: true, reason: "PAYMENT_REQUIREMENTS_REJECTED" };
    }
    const atomic = requirementAtomic(version, ctx.selectedRequirements);
    if (atomic === null) return { abort: true, reason: "PRICE_ABOVE_TOOL_MAX" };
    const reserved = await reserveMicro(Number(atomic));
    if (!reserved.ok) return { abort: true, reason: `${reserved.error}: ${reserved.message}` };
    store.pending = { micro: Number(atomic), date: reserved.date };
  });
  client.onPaymentCreationFailure(async () => {
    const store = spendContext.getStore();
    if (!store?.pending) return;
    const { micro, date } = store.pending;
    store.pending = null;
    try { await releaseMicro(micro, date); } catch { /* keep the reservation if the ledger cannot be updated */ }
  });
}
