/**
 * OpenAI Web provider domain types. Provider state lives in provider stores only.
 */

export type CatalogSource = "live" | "cache";
export type CapabilityState = "unknown" | "verified" | "incompatible";

/** One selectable ChatGPT Web model/effort combination, discovered from the logged-in account. */
export interface OpenAIWebModelDescriptor {
  /** Stable Pi-facing slug, e.g. gpt-5.6-sol-high. Derived from visible browser labels. */
  id: string;
  /** Current ChatGPT UI label for the model. */
  displayName: string;
  /** Exact label/control identity used for browser selection. */
  browserModelLabel: string;
  /** Discovered reasoning effort label, or null when the model has no effort selector. */
  effort: string | null;
  source: CatalogSource;
  discoveredAt: string;
  selectable: boolean;
  capabilityState: CapabilityState;
}

/** Versioned persisted catalog cache. Only safe model metadata; never transcripts/credentials. */
export interface ProviderCatalogCache {
  schemaVersion: number;
  discoveredAt: string;
  models: Array<Pick<OpenAIWebModelDescriptor, "id" | "displayName" | "browserModelLabel" | "effort" | "discoveredAt" | "capabilityState">>;
}

export interface DiscoveredEffort {
  label: string;
}

export interface DiscoveredModel {
  browserModelLabel: string;
  displayName: string;
  /** Selectable effort labels in UI order; null when the model exposes no effort selector. */
  efforts: string[] | null;
}

export interface CatalogRefreshResult {
  ok: boolean;
  source: CatalogSource;
  models: OpenAIWebModelDescriptor[];
  added: string[];
  removed: string[];
  changed: string[];
  error?: string;
}

export type ProviderTurnState =
  | "idle"
  | "bootstrapping"
  | "submitted"
  | "generating"
  | "waiting_for_pi_tool"
  | "completed"
  | "failed"
  | "aborted";

export interface PendingToolRequest {
  requestId: string;
  toolCallId: string;
  tool: string;
  arguments: Record<string, unknown>;
  createdAt: number;
  resolve: (result: { content: unknown; isError: boolean }) => void;
  reject: (error: Error) => void;
}
