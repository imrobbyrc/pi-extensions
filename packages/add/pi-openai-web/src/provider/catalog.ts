import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CatalogRefreshResult, DiscoveredModel, OpenAIWebModelDescriptor, ProviderCatalogCache } from "./types.js";
import { descriptorId } from "./model-ids.js";

export const CATALOG_SCHEMA_VERSION = 1;

export interface CatalogLimits {
  successTtlMs: number;
  failureRetryMs: number;
}

export interface CatalogDeps {
  cachePath: string;
  limits: CatalogLimits;
  /** Live browser discovery; injected so the service is testable without ChatGPT. */
  discover: () => Promise<DiscoveredModel[]>;
  now?: () => number;
}

export class UnknownCatalogVersionError extends Error {
  constructor(readonly foundVersion: number, readonly cachePath: string) {
    super(
      `Provider catalog cache schema version ${foundVersion} is not supported by this extension (supported: ${CATALOG_SCHEMA_VERSION}). ` +
      `Delete ${cachePath} and run /openai-web models refresh to rebuild it from the browser.`
    );
    this.name = "UnknownCatalogVersionError";
  }
}

/** Build descriptors from discovered browser combinations with deterministic ids. */
export function toDescriptors(discovered: DiscoveredModel[], source: "live" | "cache", nowIso: string): OpenAIWebModelDescriptor[] {
  const taken = new Set<string>();
  const descriptors: OpenAIWebModelDescriptor[] = [];
  for (const model of discovered) {
    if (!model.efforts) {
      const id = descriptorId(model.browserModelLabel, null, taken);
      taken.add(id);
      descriptors.push({
        id, displayName: model.displayName, browserModelLabel: model.browserModelLabel, effort: null,
        source, discoveredAt: nowIso, selectable: true, capabilityState: "unknown"
      });
      continue;
    }
    for (const effort of model.efforts) {
      const id = descriptorId(model.browserModelLabel, effort, taken);
      taken.add(id);
      descriptors.push({
        id, displayName: model.displayName, browserModelLabel: model.browserModelLabel, effort,
        source, discoveredAt: nowIso, selectable: true, capabilityState: "unknown"
      });
    }
  }
  return descriptors;
}

export function diffDescriptorIds(previous: OpenAIWebModelDescriptor[], next: OpenAIWebModelDescriptor[]): { added: string[]; removed: string[]; changed: string[] } {
  const previousById = new Map(previous.map((model) => [model.id, model]));
  const nextById = new Map(next.map((model) => [model.id, model]));
  const added = next.filter((model) => !previousById.has(model.id)).map((model) => model.id);
  const removed = previous.filter((model) => !nextById.has(model.id)).map((model) => model.id);
  const changed = next.filter((model) => {
    const before = previousById.get(model.id);
    return before && (before.browserModelLabel !== model.browserModelLabel || before.effort !== model.effort || before.displayName !== model.displayName);
  }).map((model) => model.id);
  return { added, removed, changed };
}

function descriptorToCacheEntry(descriptor: OpenAIWebModelDescriptor): ProviderCatalogCache["models"][number] {
  return {
    id: descriptor.id, displayName: descriptor.displayName, browserModelLabel: descriptor.browserModelLabel,
    effort: descriptor.effort, discoveredAt: descriptor.discoveredAt, capabilityState: descriptor.capabilityState
  };
}

/**
 * Account-aware OpenAI Web model catalog: live discovery with a last-known-good cache.
 * A failed/empty discovery never erases the cached catalog.
 */
export class OpenAIWebModelCatalog {
  private descriptors: OpenAIWebModelDescriptor[] = [];
  private cacheError: string | undefined;
  private lastDiscoveryError: string | undefined;
  private lastSuccessAt: number | undefined;
  private lastAttemptAt: number | undefined;
  private refreshInFlight: Promise<CatalogRefreshResult> | undefined;

  constructor(private readonly deps: CatalogDeps) {}

  get cacheFilePath(): string { return this.deps.cachePath; }
  get lastError(): string | undefined { return this.lastDiscoveryError ?? this.cacheError; }
  get source(): "live" | "cache" | "empty" {
    if (!this.descriptors.length) return "empty";
    return this.descriptors[0]!.source;
  }
  get ageMs(): number | undefined {
    return this.lastSuccessAt === undefined ? undefined : (this.deps.now ?? Date.now)() - this.lastSuccessAt;
  }
  get models(): OpenAIWebModelDescriptor[] { return this.descriptors; }
  get catalogVersion(): number { return CATALOG_SCHEMA_VERSION; }
  get lastAttemptAtMs(): number | undefined { return this.lastAttemptAt; }

  /** Load the last-known-good cache. Unknown versions fail actionably; missing cache is fine. */
  async loadCache(): Promise<{ loaded: boolean; count: number }> {
    let raw: string;
    try {
      raw = await readFile(this.deps.cachePath, "utf8");
    } catch {
      this.cacheError = undefined;
      return { loaded: false, count: 0 };
    }
    let parsed: ProviderCatalogCache;
    try {
      parsed = JSON.parse(raw) as ProviderCatalogCache;
    } catch (error) {
      this.cacheError = `Catalog cache is corrupt: ${error instanceof Error ? error.message : String(error)}`;
      return { loaded: false, count: 0 };
    }
    if (parsed.schemaVersion !== CATALOG_SCHEMA_VERSION) {
      this.cacheError = undefined;
      throw new UnknownCatalogVersionError(parsed.schemaVersion, this.deps.cachePath);
    }
    this.descriptors = parsed.models.map((entry) => ({ ...entry, source: "cache" as const, selectable: true }));
    this.lastSuccessAt = Date.parse(parsed.discoveredAt) || undefined;
    this.cacheError = undefined;
    return { loaded: true, count: this.descriptors.length };
  }

  private async writeCache(models: OpenAIWebModelDescriptor[], discoveredAt: string): Promise<void> {
    const payload: ProviderCatalogCache = {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      discoveredAt,
      models: models.map(descriptorToCacheEntry)
    };
    await mkdir(dirname(this.deps.cachePath), { recursive: true });
    const tmp = `${this.deps.cachePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tmp, this.deps.cachePath);
  }

  shouldRefresh(): boolean {
    if (!this.descriptors.length) return true;
    const age = this.ageMs ?? Number.POSITIVE_INFINITY;
    const ttl = this.lastDiscoveryError ? this.deps.limits.failureRetryMs : this.deps.limits.successTtlMs;
    return age >= ttl;
  }

  /** Fresh discovery; cache is replaced only on a complete valid catalog. Single-flight. */
  async refresh(): Promise<CatalogRefreshResult> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.runRefresh().finally(() => { this.refreshInFlight = undefined; });
    return this.refreshInFlight;
  }

  private async runRefresh(): Promise<CatalogRefreshResult> {
    const previous = this.descriptors;
    this.lastAttemptAt = (this.deps.now ?? Date.now)();
    try {
      const discovered = await this.deps.discover();
      if (!discovered.length) throw new Error("Discovery returned no selectable models for this account.");
      const nowIso = new Date(this.lastAttemptAt).toISOString();
      const next = toDescriptors(discovered, "live", nowIso);
      await this.writeCache(next, nowIso);
      this.descriptors = next;
      this.lastSuccessAt = this.lastAttemptAt;
      this.lastDiscoveryError = undefined;
      const { added, removed, changed } = diffDescriptorIds(previous, next);
      return { ok: true, source: "live", models: next, added, removed, changed };
    } catch (error) {
      this.lastDiscoveryError = error instanceof Error ? error.message : String(error);
      // Failed discovery keeps the last-known-good catalog (possibly empty on first run).
      return { ok: false, source: previous.length ? "cache" : "cache", models: previous, added: [], removed: [], changed: [], error: this.lastDiscoveryError };
    }
  }

  resolve(id: string): OpenAIWebModelDescriptor | undefined {
    return this.descriptors.find((model) => model.id === id);
  }
}
