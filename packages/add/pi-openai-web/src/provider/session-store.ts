import { appendFile, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Local session transcript store: every provider conversation message and
 * compaction checkpoint is recorded to JSONL for durable local diagnostics.
 */

export interface SessionRecord {
  conversationId: string;
  timestamp: number;
  type: "user" | "assistant" | "tool_call" | "tool_result" | "compaction" | "worker";
  content: string;
  toolName?: string;
  workerId?: string;
}

export interface SessionQueryOptions {
  conversationId?: string;
  query?: string;
  limit?: number;
}

export const SESSION_RETENTION_DAYS_DEFAULT = 30;
const MAX_QUERY_RESULTS = 50;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

function validateConversationId(conversationId: string): string {
  if (!SESSION_ID_PATTERN.test(conversationId)) throw new Error("invalid_session_conversation_id");
  return conversationId;
}

export class SessionStore {
  constructor(
    private readonly sessionsDir: string,
    private readonly retentionDays: number = SESSION_RETENTION_DAYS_DEFAULT
  ) {}

  private filePath(conversationId: string): string {
    return join(this.sessionsDir, `${validateConversationId(conversationId)}.jsonl`);
  }

  async append(record: SessionRecord): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await appendFile(this.filePath(record.conversationId), `${JSON.stringify(record)}\n`, "utf8");
  }

  async query(options: SessionQueryOptions): Promise<SessionRecord[]> {
    const files = await this.listFiles();
    const conversationId = options.conversationId ? validateConversationId(options.conversationId) : undefined;
    const results: SessionRecord[] = [];
    const needle = options.query?.toLowerCase();
    const limit = Math.min(options.limit ?? MAX_QUERY_RESULTS, MAX_QUERY_RESULTS);

    // Read newest files first for recency bias.
    const sorted = await this.sortByModified(files);
    for (const file of sorted) {
      if (results.length >= limit) break;
      if (conversationId && file.name !== `${conversationId}.jsonl`) continue;
      const lines = await this.readLines(join(this.sessionsDir, file.name));
      // Scan newest-first within each file.
      for (let i = lines.length - 1; i >= 0 && results.length < limit; i -= 1) {
        const record = lines[i]!;
        if (needle && !record.content.toLowerCase().includes(needle) && !(record.toolName ?? "").toLowerCase().includes(needle)) continue;
        results.push(record);
      }
    }
    return results;
  }

  async listConversations(): Promise<Array<{ conversationId: string; recordCount: number; lastModified: number }>> {
    const files = await this.listFiles();
    const conversations: Array<{ conversationId: string; recordCount: number; lastModified: number }> = [];
    for (const file of files) {
      const conversationId = file.name.replace(/\.jsonl$/, "");
      const lines = await this.readLines(join(this.sessionsDir, file.name));
      conversations.push({ conversationId, recordCount: lines.length, lastModified: file.mtimeMs });
    }
    return conversations.sort((a, b) => b.lastModified - a.lastModified);
  }

  /** Remove files older than the retention window. */
  async prune(now = Date.now()): Promise<number> {
    const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
    const files = await this.listFiles();
    let removed = 0;
    for (const file of files) {
      if (file.mtimeMs < cutoff) {
        await unlink(join(this.sessionsDir, file.name)).catch(() => { /* already gone */ });
        removed += 1;
      }
    }
    return removed;
  }

  private async listFiles(): Promise<Array<{ name: string; mtimeMs: number }>> {
    try {
      const names = await readdir(this.sessionsDir);
      const files: Array<{ name: string; mtimeMs: number }> = [];
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const info = await stat(join(this.sessionsDir, name)).catch(() => undefined);
        if (info) files.push({ name, mtimeMs: info.mtimeMs });
      }
      return files;
    } catch {
      return [];
    }
  }

  private async sortByModified(files: Array<{ name: string; mtimeMs: number }>): Promise<Array<{ name: string; mtimeMs: number }>> {
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  private async readLines(path: string): Promise<SessionRecord[]> {
    try {
      const raw = await readFile(path, "utf8");
      return raw.split("\n").filter(Boolean).map(line => {
        try {
          return JSON.parse(line) as SessionRecord;
        } catch {
          return undefined;
        }
      }).filter((record): record is SessionRecord => record !== undefined);
    } catch {
      return [];
    }
  }

  async clearAll(): Promise<number> {
    const files = await this.listFiles();
    for (const file of files) {
      await unlink(join(this.sessionsDir, file.name)).catch(() => {});
    }
    return files.length;
  }
}
