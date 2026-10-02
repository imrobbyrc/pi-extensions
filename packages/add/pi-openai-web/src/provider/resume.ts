import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isValidConversationId } from "../browser/chatgpt.js";

/** Durable, non-secret identity for reconnecting a provider browser turn. */
export interface ProviderResumeMetadata {
  schemaVersion: 1;
  targetId: string;
  conversationId?: string;
  descriptorKey: string;
  branchKey: string;
  leaseKey: string;
  epoch: number;
  syncedMessageCount?: number;
  /** Running provider context-token estimate at save time. Absent in older metadata: reconnect restarts the estimate at zero. */
  estimatedContextTokens?: number;
  /**
   * Explicit bootstrap lifecycle state at save time: the full Lead/bootstrap
   * contract turn completed successfully. Absent in older metadata: reconnect
   * fails safe to pending (the full bootstrap contract is re-established)
   * rather than assuming a completion that was never recorded.
   */
  bootstrapComplete?: boolean;
  updatedAt: string;
}

export interface ProviderResumeStore {
  load(): Promise<ProviderResumeMetadata | undefined>;
  save(metadata: ProviderResumeMetadata): Promise<void>;
  clear(): Promise<void>;
}

/** Atomic JSON file store. Contains only browser target/conversation identifiers. */
export class FileProviderResumeStore implements ProviderResumeStore {
  constructor(private readonly path: string) {}

  async load(): Promise<ProviderResumeMetadata | undefined> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as Partial<ProviderResumeMetadata>;
      if (value.schemaVersion !== 1 || typeof value.targetId !== "string" || typeof value.descriptorKey !== "string"
        || typeof value.branchKey !== "string" || typeof value.leaseKey !== "string" || typeof value.epoch !== "number"
        ) return undefined;
      if (value.conversationId !== undefined && typeof value.conversationId !== "string") return undefined;
      // Optional token estimate: absent (older metadata) stays valid; a present value must be a finite non-negative number.
      if (value.estimatedContextTokens !== undefined
        && (typeof value.estimatedContextTokens !== "number" || !Number.isFinite(value.estimatedContextTokens) || value.estimatedContextTokens < 0)
      ) return undefined;
      // Optional explicit bootstrap completion state: absent (older metadata)
      // stays valid and reconnect treats it as pending; a present value must be
      // a boolean or the whole load fails closed at this parse boundary.
      if (value.bootstrapComplete !== undefined && typeof value.bootstrapComplete !== "boolean") return undefined;
      return value as ProviderResumeMetadata;
    } catch {
      return undefined;
    }
  }

  async save(metadata: ProviderResumeMetadata): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await rename(temporary, this.path);
  }

  async clear(): Promise<void> {
    const { unlink } = await import("node:fs/promises");
    await unlink(this.path).catch(() => {});
  }
}

/** In-memory implementation useful to hosts/tests that do not want filesystem state. */
export class MemoryProviderResumeStore implements ProviderResumeStore {
  private metadata: ProviderResumeMetadata | undefined;
  async load(): Promise<ProviderResumeMetadata | undefined> { return this.metadata ? { ...this.metadata } : undefined; }
  async save(metadata: ProviderResumeMetadata): Promise<void> { this.metadata = { ...metadata }; }
  async clear(): Promise<void> { this.metadata = undefined; }
}
