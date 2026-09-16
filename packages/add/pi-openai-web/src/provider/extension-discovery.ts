import type { DiscoveredModel } from "./types.js";
import { evalJson, type CdpClient } from "./page.js";

interface PickerState {
  source: "pi-chatgpt-picker-extension";
  updatedAt: number;
  models: Array<{ browserModelLabel: string; displayName: string; checked: boolean }>;
  effort: string | null;
}

/**
 * Read optional companion-extension state. The extension exposes only visible
 * picker controls through a page-world marker; absent/stale state returns null.
 */
export async function readExtensionPickerState(client: CdpClient, maxAgeMs = 30_000): Promise<DiscoveredModel[] | null> {
  const state = await evalJson<PickerState | null>(client, "window.__PI_CHATGPT_PICKER_STATE__ ?? null").catch(() => undefined);
  if (!state || state.source !== "pi-chatgpt-picker-extension" || Date.now() - state.updatedAt > maxAgeMs) return null;
  const models = state.models
    .filter(model => typeof model.browserModelLabel === "string" && model.browserModelLabel.length > 0)
    .map(model => ({ browserModelLabel: model.browserModelLabel, displayName: model.displayName || model.browserModelLabel, efforts: null }));
  return models.length ? models : null;
}
