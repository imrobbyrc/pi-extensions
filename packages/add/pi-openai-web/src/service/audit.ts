import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Durable, redacted audit log for lead tool calls, herdr lifecycle events, and
 * codemode executions. Append-only JSONL under `<stateDir>/audit/`.
 *
 * Non-negotiable redaction contract (enforced here, not by callers' good
 * behavior): events carry ONLY the allowlisted scalar metadata each record
 * constructor passes. Credentials, tokens, full handoffs, worker prompts,
 * Codemode script source, and file contents are never fields any caller can
 * reach this log with — and every string that DOES travel is truncated,
 * whitespace-collapsed, and scrubbed of credential-shaped substrings before it
 * is serialized. Audit failures never break the audited operation.
 */

/** Bounds for any one audited string value. */
export const AUDIT_TEXT_MAX = 200;
/** Detail record serialized bound; over-budget detail is dropped whole (fail closed). */
export const AUDIT_DETAIL_JSON_MAX = 2_000;
/** Rotation threshold for the active JSONL file. */
export const AUDIT_FILE_MAX_BYTES = 2 * 1024 * 1024;

export type AuditActor = "lead-tool" | "codemode" | "system";
export type AuditOutcome = "ok" | "error";

export interface AuditEvent {
  ts: string;
  actor: AuditActor;
  tool: string;
  action?: string;
  outcome: AuditOutcome;
  durationMs?: number;
  detail?: Record<string, unknown>;
}

/** Credential-shaped substrings that must never survive into the log. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/gi,
  /\b(?:bearer|token|api[_-]?key|password|secret)\s*[:=]\s*\S{8,}/gi,
  /CONTROL_PLANE_API_KEY\s*[:=]\s*\S+/g
];

/** Truncate, collapse whitespace, and scrub credential-shaped substrings. */
export function redactText(value: string, max = AUDIT_TEXT_MAX): string {
  let text = String(value).replace(/\s+/g, " ").trim();
  for (const pattern of CREDENTIAL_PATTERNS) text = text.replace(pattern, "[redacted]");
  if (text.length > max) text = `${text.slice(0, max)}…`;
  return text;
}

/** Redact an unknown value into audit-safe scalar form; non-scalars become type tags. */
function redactValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return redactText(value);
  return `[${typeof value}]`;
}

/** Build one audit event with every string scrubbed and bounded; detail over budget is dropped whole. */
export function buildAuditEvent(input: {
  actor: AuditActor;
  tool: string;
  action?: string;
  outcome: AuditOutcome;
  durationMs?: number;
  detail?: Record<string, unknown>;
  now?: () => Date;
}): AuditEvent {
  const event: AuditEvent = {
    ts: (input.now ?? (() => new Date()))().toISOString(),
    actor: input.actor,
    tool: redactText(input.tool, 64),
    outcome: input.outcome
  };
  if (input.action !== undefined) event.action = redactText(input.action, 32);
  if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0) {
    event.durationMs = Math.round(input.durationMs);
  }
  if (input.detail !== undefined) {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.detail)) {
      if (value === undefined) continue;
      redacted[redactText(key, 64)] = redactValue(value);
    }
    const serialized = JSON.stringify(redacted);
    if (serialized !== undefined && serialized.length <= AUDIT_DETAIL_JSON_MAX) event.detail = redacted;
    // Over-budget detail is dropped whole: never write truncated raw content.
  }
  return event;
}

export interface AuditLogStats {
  events: number;
  bytes: number;
  path: string;
  lastError: string | undefined;
  lastEvent: string | undefined;
}

/** Structural sink the MCP factory audits through; HarnessAuditLog satisfies it. Fire-and-forget by contract. */
export interface AuditRecorder {
  record(input: {
    actor: AuditActor;
    tool: string;
    action?: string;
    outcome: AuditOutcome;
    durationMs?: number;
    detail?: Record<string, unknown>;
  }): void;
}

/**
 * Append-only JSONL audit log. `record()` is fire-and-forget safe: internal
 * write failures are captured in `lastError` (surfaced by doctor) and never
 * propagate into the audited call path. Size-rotation keeps one previous file.
 */
export class HarnessAuditLog {
  private events = 0;
  private lastError: string | undefined;
  private lastEvent: string | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  get path(): string {
    return this.filePath;
  }

  /** Append one event; serialization/redaction happens inside buildAuditEvent. */
  record(input: Omit<Parameters<typeof buildAuditEvent>[0], "now">): void {
    let event: AuditEvent;
    try {
      event = buildAuditEvent({ ...input, now: this.now });
    } catch (error) {
      this.lastError = redactText(error instanceof Error ? error.message : String(error));
      return;
    }
    this.events += 1;
    this.lastEvent = `${event.actor} ${event.tool}${event.action ? `:${event.action}` : ""} ${event.outcome}`;
    this.writeChain = this.writeChain
      .then(() => this.append(event))
      .catch((error: unknown) => {
        this.lastError = redactText(error instanceof Error ? error.message : String(error));
      });
  }

  private async append(event: AuditEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const info = await stat(this.filePath);
      if (info.size + line.length > AUDIT_FILE_MAX_BYTES) {
        await rename(this.filePath, `${this.filePath}.1`);
      }
    } catch {
      // No active file yet — nothing to rotate.
    }
    await appendFile(this.filePath, line, "utf8");
    if (this.lastError) this.lastError = undefined;
  }

  /** Wait for queued writes to settle (tests/doctor). */
  async settle(): Promise<void> {
    await this.writeChain;
  }

  /** Session-scoped counters plus bounded last-error evidence; never returns log contents. */
  stats(): AuditLogStats {
    return { events: this.events, bytes: 0, path: this.filePath, lastError: this.lastError, lastEvent: this.lastEvent };
  }
}
