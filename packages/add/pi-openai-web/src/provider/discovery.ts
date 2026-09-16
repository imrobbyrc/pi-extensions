import CDP from "chrome-remote-interface";
import type { HarnessConfig } from "../types.js";
import type { DiscoveredModel } from "./types.js";
import { readExtensionPickerState } from "./extension-discovery.js";
import { attach, enablePage, enableTemporaryChatBestEffort, evalJson, sleep, waitFor, waitForComposer, type CdpClient } from "./page.js";
import {
  closeMenus, enumerateModelRows, FIND_EFFORT_POWER_ITEM, FIND_TRIGGER,
  openModelPicker, readEffortDescription, readLockedPositions,
  setEffortPosition, syntheticClickElement
} from "./model-picker.js";


/**
 * Account-aware model catalog discovery from normal visible ChatGPT Web controls:
 * open the model picker, enumerate selectable model rows, and for each model
 * enumerate its reasoning-effort levels by walking the visible effort slider.
 * No cookies, storage, React internals, or private network endpoints are consulted.
 * The probe target uses Temporary Chat best-effort and is always closed.
 */

async function selectModelRow(client: CdpClient, label: string): Promise<boolean> {
  if (!(await openModelPicker(client))) return false;
  const clicked = await syntheticClickElement(client,
    `[...document.querySelectorAll('[role="menuitemradio"]')]
      .filter(el => el.offsetParent !== null)
      .find(el => (el.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(label)})`);
  if (!clicked) return false;
  // Selecting a different model closes the picker; re-selecting the current one may keep it open.
  await waitFor(client, `() => ![...document.querySelectorAll('[role="menuitemradio"]')].some(el => el.offsetParent !== null)`, 3_000);
  // Verify by readback: model selection state can commit after menu dismissal.
  // Retry once for rows whose selection update races the picker remount.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await sleep(500);
    if (!(await openModelPicker(client))) return false;
    await sleep(500);
    const checked = await evalJson<boolean>(client, `(() => {
      const rows = [...document.querySelectorAll('[role="menuitemradio"]')]
        .filter(el => el.offsetParent !== null)
        .filter(el => (el.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(label)});
      return rows.length === 1 && (rows[0].getAttribute('aria-checked') === 'true' || rows[0].getAttribute('data-state') === 'checked');
    })()`);
    await closeMenus(client);
    if (checked === true) return true;
    if (attempt === 0 && await openModelPicker(client)) {
      await syntheticClickElement(client,
        `[...document.querySelectorAll('[role="menuitemradio"]')]
          .filter(el => el.offsetParent !== null)
          .find(el => (el.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(label)})`);
    }
  }
  return false;
}

/**
 * Enumerate selectable effort labels for the currently selected model by walking
 * the visible Power slider and reading its description ("High, 3 of 4.") at each
 * position. Locked ticks (gated for this account) are excluded; the original
 * level is restored afterwards. Returns null when the model has no effort control.
 */
async function enumerateEffortOptions(client: CdpClient, log?: (message: string) => void): Promise<string[] | null> {
  const initial = await readEffortDescription(client);
  if (!initial) return null;
  log?.(`effort control found: ${initial.label}, ${initial.position} of ${initial.total}`);
  const locked = new Set(await readLockedPositions(client, initial.total));
  const labels = new Map<number, string>([[initial.position, initial.label]]);

  const record = async (): Promise<boolean> => {
    const next = await readEffortDescription(client);
    if (!next) return false;
    labels.set(next.position, next.label);
    return true;
  };

  // Click every unlocked tick and read its label.
  for (let position = 1; position <= initial.total; position += 1) {
    if (locked.has(position)) continue;
    const value = await setEffortPosition(client, position);
    if (value === null) break;
    const next = await readEffortDescription(client);
    if (!next) continue; // gated/unreadable position
    labels.set(next.position, next.label);
  }
    await closeMenus(client);
  const offered: string[] = [];
  for (let position = 1; position <= initial.total; position += 1) {
    if (locked.has(position)) continue;
    const label = labels.get(position);
    if (label) offered.push(label);
  }
  log?.(`effort levels: ${offered.join(", ") || "(none)"} (locked: ${[...locked].join(",") || "none"})`);
  return offered.length ? offered : null;
}

/**
 * Discover all selectable model/effort combinations on a dedicated probe target.
 */
export async function discoverModelCatalog(config: HarnessConfig, log?: (message: string) => void): Promise<DiscoveredModel[]> {
  const target = await CDP.New({ host: config.cdpHost, port: config.cdpPort, url: config.chatgptUrl });
  if (!target.id) throw new Error("CDP created catalog probe tab without targetId.");
  let client: CdpClient | undefined;
  try {
    client = await attach(config, target.id);
    await enablePage(client);
    await waitForComposer(client);
    await enableTemporaryChatBestEffort(client);
    // Temporary Chat toggling can remount the composer; wait until the picker trigger is back.
    if (!(await waitFor(client, `() => (${FIND_TRIGGER}) !== null`, 10_000))) {
      throw new Error("ChatGPT model/effort picker trigger did not appear after Temporary Chat setup.");
    }
    await sleep(500);
    if (!(await openModelPicker(client))) {
      throw new Error("ChatGPT model picker trigger was not found or did not open. Run /chatgpt-browser-debug to inspect controls.");
    }
    const extensionModels = await readExtensionPickerState(client);
    let rows = extensionModels?.map(model => ({ label: model.browserModelLabel, checked: false })) ?? await enumerateModelRows(client);
    if (!rows.length) throw new Error("No selectable model rows were visible in the ChatGPT model picker.");
    log?.(`${extensionModels ? "extension picker state" : "visible picker rows"}: ${rows.map(row => row.label).join(", ")}`);

    const discovered: DiscoveredModel[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.label)) continue;
      seen.add(row.label);
      if (!(await selectModelRow(client, row.label))) {
        log?.(`row not selectable: ${row.label}`);
        continue;
      }
      await sleep(700);
      // Effort discovery for this model: reopen the picker and walk the effort slider.
      let efforts: string[] | null = null;
      if (!(await openModelPicker(client))) {
        log?.("model picker did not reopen; stopping discovery loop");
        break;
      }
      await sleep(250);
      const hasEffortControl = (await evalJson<boolean>(client, `(${FIND_EFFORT_POWER_ITEM}) !== null`)) === true;
      if (hasEffortControl) {
        efforts = await enumerateEffortOptions(client, log);
      }
      await closeMenus(client);
      discovered.push({ browserModelLabel: row.label, displayName: row.label, efforts: efforts && efforts.length ? efforts : null });
    }
    // A row count check against discovery guarantees the catalog is complete.
    if (!discovered.length) throw new Error("No models could be selected during discovery.");
    return discovered;
  } finally {
    await client?.close().catch(() => { /* probe cleanup is best-effort */ });
    await CDP.Close({ host: config.cdpHost, port: config.cdpPort, id: target.id }).catch(() => { /* already closed */ });
  }
}
