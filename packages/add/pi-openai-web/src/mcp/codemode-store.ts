import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

/**
 * Lifecycle-safe persistent Codemode store.
 *
 * Codemode scripts get a `store` object inside the OFFICIAL
 * @earendil-works/pi-codemode sandbox (never a local reimplementation); the
 * sandbox collects `storeWrites` and returns them ONLY on a successful
 * execution. This module persists exactly those writes, atomically, scoped to
 * the authoritative Pi lifecycle identity (the Pi session id): there is no
 * shared cross-session store, and writes are committed only after a
 * policy-valid successful execution — never partially, never on failure,
 * timeout, abort, budget exhaustion, or invalid writes.
 */

/** Fail-closed store policy error; carries no store contents. */
export class CodemodeStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodemodeStoreError";
  }
}

// Protocol-bound store limits: every bound is fail-closed at commit time.
export const CODEMODE_STORE_MAX_KEYS = 64;
export const CODEMODE_STORE_KEY_MAX = 64;
export const CODEMODE_STORE_VALUE_MAX_BYTES = 8_192;
export const CODEMODE_STORE_FILE_MAX_BYTES = 256 * 1024;
/** Key grammar: filesystem/JSON-safe identifier segments only. */
export const CODEMODE_STORE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The official sandbox's writes payload shape (ok results only). */
export interface CodemodeStoreWrites {
  set: Record<string, unknown>;
  delete: string[];
}

export type CodemodeStoreSnapshot = Record<string, unknown>;

export interface CodemodeStoreStats {
  identity: string;
  keys: number;
  bytes: number;
  lastError: string | undefined;
}

/** Stable filesystem name for one lifecycle identity: readable when safe, hashed otherwise. */
export function storeIdentityFile(identity: string): string {
  const safe = identity.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (safe.length >= 1 && CODEMODE_STORE_KEY_PATTERN.test(safe)) return `${safe}.json`;
  return `id-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}.json`;
}

/** Validate ONE serialized value: JSON-serializable, defined, bounded. */
function validateValue(key: string, value: unknown): void {
  if (value === undefined) throw new CodemodeStoreError(`codemode_store_invalid: store key ${JSON.stringify(key)} has an undefined value.`);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new CodemodeStoreError(`codemode_store_invalid: store key ${JSON.stringify(key)} has a value that is not JSON-serializable.`);
  }
  if (serialized === undefined) {
    throw new CodemodeStoreError(`codemode_store_invalid: store key ${JSON.stringify(key)} has a value that is not JSON-serializable.`);
  }
  if (serialized.length > CODEMODE_STORE_VALUE_MAX_BYTES) {
    throw new CodemodeStoreError(`codemode_store_invalid: store key ${JSON.stringify(key)} exceeds the ${CODEMODE_STORE_VALUE_MAX_BYTES}-byte value limit.`);
  }
}

/**
 * Validate the full post-apply state of one commit: keys, values, counts, and
 * total size. Pure — throws CodemodeStoreError on any violation, mutates
 * nothing, so an invalid batch can never leave a partial commit behind.
 */
export function validateCodemodeStoreState(state: CodemodeStoreSnapshot): void {
  const keys = Object.keys(state);
  if (keys.length > CODEMODE_STORE_MAX_KEYS) {
    throw new CodemodeStoreError(`codemode_store_invalid: store exceeds the ${CODEMODE_STORE_MAX_KEYS}-key limit.`);
  }
  for (const key of keys) {
    if (typeof key !== "string" || key.length < 1 || key.length > CODEMODE_STORE_KEY_MAX || !CODEMODE_STORE_KEY_PATTERN.test(key)) {
      throw new CodemodeStoreError(`codemode_store_invalid: store key ${JSON.stringify(key)} is not a bounded identifier (max ${CODEMODE_STORE_KEY_MAX} chars, pattern ${CODEMODE_STORE_KEY_PATTERN}).`);
    }
    validateValue(key, state[key]);
  }
  const total = JSON.stringify(state)?.length ?? 0;
  if (total > CODEMODE_STORE_FILE_MAX_BYTES) {
    throw new CodemodeStoreError(`codemode_store_invalid: store exceeds the ${CODEMODE_STORE_FILE_MAX_BYTES}-byte total limit.`);
  }
}

/** Normalize the sandbox's writes payload shape (defensive: never trust it blindly). */
export function normalizeCodemodeStoreWrites(raw: unknown): CodemodeStoreWrites {
  if (typeof raw !== "object" || raw === null) {
    throw new CodemodeStoreError("codemode_store_invalid: sandbox returned no store writes payload.");
  }
  const record = raw as { set?: unknown; delete?: unknown };
  if (record.set === undefined && record.delete === undefined) {
    throw new CodemodeStoreError("codemode_store_invalid: sandbox returned no store writes payload.");
  }
  if (record.set !== undefined && (typeof record.set !== "object" || record.set === null || Array.isArray(record.set))) {
    throw new CodemodeStoreError("codemode_store_invalid: store set writes must be an object.");
  }
  if (record.delete !== undefined && !Array.isArray(record.delete)) {
    throw new CodemodeStoreError("codemode_store_invalid: store delete writes must be an array.");
  }
  const deletes = (record.delete ?? []) as unknown[];
  for (const key of deletes) {
    if (typeof key !== "string") {
      throw new CodemodeStoreError("codemode_store_invalid: store delete writes must be string keys.");
    }
  }
  return { set: { ...(record.set as Record<string, unknown>) }, delete: deletes.map((key) => key as string) };
}

/** Pure apply of validated-normalized writes onto a snapshot (last write wins; unknown deletes are no-ops). */
export function applyCodemodeStoreWrites(current: CodemodeStoreSnapshot, writes: CodemodeStoreWrites): CodemodeStoreSnapshot {
  const next: CodemodeStoreSnapshot = { ...current };
  for (const key of writes.delete) delete next[key];
  return { ...next, ...writes.set };
}

/**
 * Durable per-identity store. Commits are serialized per identity and land via
 * a single atomic tmp+rename write, so concurrent executions cannot interleave
 * partial state and a failed write never corrupts the previous snapshot.
 */
export class CodemodeStore {
  private readonly commits = new Map<string, Promise<unknown>>();
  private readonly lastErrors = new Map<string, string>();

  constructor(private readonly dir: string) {}

  private pathFor(identity: string): string {
    return join(this.dir, storeIdentityFile(identity));
  }

  private setError(identity: string, message: string | undefined): void {
    if (message === undefined) this.lastErrors.delete(identity);
    else this.lastErrors.set(identity, message);
  }

  /** Load one identity's snapshot. Missing or corrupt files resolve empty (never wiped); the failure is surfaced via stats(). */
  async load(identity: string): Promise<CodemodeStoreSnapshot> {
    try {
      const raw = await readFile(this.pathFor(identity), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        this.setError(identity, "store snapshot is not an object; starting empty");
        return {};
      }
      this.setError(identity, undefined);
      return { ...(parsed as CodemodeStoreSnapshot) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.setError(identity, undefined);
        return {};
      }
      this.setError(identity, `store snapshot unreadable (${code ?? "unknown"}); starting empty`);
      return {};
    }
  }

  /**
   * Validate and atomically persist one successful execution's writes.
   * Validation covers the ENTIRE post-apply state before anything touches the
   * disk, so an invalid batch is rejected whole — no partial commit exists.
   */
  commit(identity: string, current: CodemodeStoreSnapshot, writesRaw: unknown): Promise<void> {
    const outcome = (this.commits.get(identity) ?? Promise.resolve()).then(async () => {
      const writes = normalizeCodemodeStoreWrites(writesRaw);
      const next = applyCodemodeStoreWrites(current, writes);
      validateCodemodeStoreState(next);
      await mkdir(this.dir, { recursive: true });
      const target = this.pathFor(identity);
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await rename(tmp, target);
      this.setError(identity, undefined);
    });
    this.commits.set(identity, outcome.then(() => undefined, () => undefined));
    outcome.catch(() => {
      // Record only the bounded error class/message; store contents never travel.
      this.setError(identity, "last commit failed (no partial state was written)");
    });
    return outcome;
  }

  /** Bounded diagnostics for doctor; never returns store contents. */
  async stats(identity: string): Promise<CodemodeStoreStats> {
    const snapshot = await this.load(identity);
    return {
      identity,
      keys: Object.keys(snapshot).length,
      bytes: JSON.stringify(snapshot)?.length ?? 0,
      lastError: this.lastErrors.get(identity)
    };
  }

  /** Remove one identity's snapshot (used by tests and explicit operator reset). */
  async clear(identity: string): Promise<void> {
    await rm(this.pathFor(identity), { force: true });
    this.setError(identity, undefined);
  }
}
