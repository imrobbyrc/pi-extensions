import { evalJson, sleep, waitFor, type CdpClient } from "./page.js";

/**
 * ChatGPT model/effort picker primitives operating only on normal visible controls.
 * Live-verified DOM (V2.4):
 *  - composer trailing slot has a button[aria-haspopup=menu] showing the current
 *    model's effort label (e.g. "High"); real mouse clicks open the "intelligence
 *    picker" menu listing selectable models as [role=menuitemradio].
 *  - a quick-effort [role=menuitem] (text = current effort label) opens a Radix
 *    slider ([data-model-reasoning-effort-slider]); Arrow keys change the level and
 *    the quick-item label tracks it. Gated levels surface as an "upgrade" upsell row.
 * Synthetic .click() does not open the menu; trusted CDP mouse events are required.
 */

export const EFFORT_LABEL = /^(instant|minimal|low|medium|high|ultra|xhigh|max)$/i;
const EFFORT_ORDER = ["instant", "minimal", "low", "medium", "high", "ultra", "xhigh", "max"];
const UPGRADE_ROW_PATTERN = /upgrade|upsell|pro$|plus plan|business|enterprise/i;

export const FIND_TRIGGER = `(() => {
  const slots = [...document.querySelectorAll('[data-composer-transition-slot="trailing"], [data-composer-transition-slot="end"]')];
  const triggers = slots.flatMap(slot => [...slot.querySelectorAll('button[aria-haspopup="menu"]')]).filter(el => el.offsetParent !== null);
  const trigger = triggers.find(el => ${EFFORT_LABEL.toString()}.test((el.textContent || '').trim()))
    ?? triggers[0];
  return trigger || null;
})()`;

async function elementCoords(client: CdpClient, locate: string): Promise<{ x: number; y: number } | null> {
  return (await evalJson<{ x: number; y: number } | null>(client, `(() => {
    const el = (${locate});
    if (!el || !(el instanceof Element)) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`)) ?? null;
}

/** Trusted mouse click at the center of the element matched by a JS expression. */
export async function mouseClickElement(client: CdpClient, locate: string): Promise<boolean> {
  const coords = await elementCoords(client, locate);
  if (!coords) return false;
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
  return true;
}

/**
 * Synthetic pointer+mouse event sequence on the matched element. Model rows sit
 * under hover tooltips that intercept trusted clicks, so row selection uses this.
 */
export async function syntheticClickElement(client: CdpClient, locate: string): Promise<boolean> {
  return (await evalJson<boolean>(client, `(() => {
    const el = (${locate});
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, button: 0, clientX: Math.round(rect.left + rect.width / 2), clientY: Math.round(rect.top + rect.height / 2) };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return true;
  })()`)) === true;
}

export interface PickerRow {
  label: string;
  checked: boolean;
}

export const FIND_MODEL_ROW = (label: string): string =>
  `[...document.querySelectorAll('[role="menuitemradio"]')]
    .filter(el => el.offsetParent !== null)
    .find(el => (el.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(label)})`;

/** The effort "Power" control: a menuitem containing the effort slider. */
export const FIND_EFFORT_POWER_ITEM = `[...document.querySelectorAll('[role="menuitem"]')]
  .filter(el => el.offsetParent !== null)
  .find(el => el.querySelector('[data-model-reasoning-effort-slider]'))`;

export const FIND_SLIDER = `[...document.querySelectorAll('[data-model-reasoning-effort-slider] [role="slider"]')].find(el => el.offsetParent !== null)`;

/** Open the model/effort picker (idempotent) and wait for model rows to be visible. */
export async function openModelPicker(client: CdpClient): Promise<boolean> {
  // Do not treat an arbitrary ChatGPT menu item (for example the attachment
  // menu left over from a previous turn) as the model picker.  That stale menu
  // used to make this function return early, after which model selection failed
  // even though the model trigger was available.
  const modelRowsVisible = `[...document.querySelectorAll('[role="menuitemradio"]')]
    .some(el => el.offsetParent !== null && (el.textContent || '').replace(/\\s+/g, ' ').trim().length > 0)`;
  if ((await evalJson<boolean>(client, modelRowsVisible)) === true) return true; // already open

  // The composer re-renders while the page settles; re-wait for the trigger and
  // retry.  Always dismiss a stale menu before another trusted trigger click so
  // its overlay cannot intercept the click coordinates.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) await closeMenus(client);
    if (!(await waitFor(client, `() => (${FIND_TRIGGER}) !== null`, 5_000))) continue;
    if (await mouseClickElement(client, FIND_TRIGGER)) {
      if (await waitFor(client, modelRowsVisible, 2_500)) {
        await sleep(300);
        return true;
      }
    }
    await closeMenus(client);
  }
  return false;
}

/** Close any open picker/menu with a trusted Escape key press. */
export async function closeMenus(client: CdpClient): Promise<void> {
  await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(300);
  // Radix menus sometimes need a second press when focus sits on a submenu item.
  const stillOpen = await evalJson<boolean>(client, `[...document.querySelectorAll('[role="menu"][data-state="open"], [role="dialog"][data-state="open"]')].some(el => el.offsetParent !== null)`);
  if (stillOpen === true) {
    await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(300);
  }
}

export async function enumerateModelRows(client: CdpClient): Promise<PickerRow[]> {
  const rows = await evalJson<PickerRow[]>(client, `(() => {
    return [...document.querySelectorAll('[role="menuitemradio"]')]
      .filter(el => el.offsetParent !== null)
      .filter(el => {
        if (el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')) return false;
        if (el.tagName === 'A' && el.getAttribute('href')) return false;
        const label = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        return label.length > 0 && !new RegExp(${JSON.stringify(UPGRADE_ROW_PATTERN.source)}, 'i').test(label);
      })
      .map(el => ({
        label: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
        checked: el.getAttribute('aria-checked') === 'true'
      }));
  })()`);
  return rows ?? [];
}

/** Read the composer effort trigger label; null when the model exposes no effort control. */
export async function readEffortTrigger(client: CdpClient): Promise<string | null> {
  // The trigger remounts while the composer settles; poll briefly.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const label = await evalJson<string | null>(client, `(() => {
      const slots = [...document.querySelectorAll('[data-composer-transition-slot="trailing"], [data-composer-transition-slot="end"]')];
      const triggers = slots.flatMap(slot => [...slot.querySelectorAll('button[aria-haspopup="menu"]')]).filter(el => el.offsetParent !== null);
      const trigger = triggers.find(el => ${EFFORT_LABEL.toString()}.test((el.textContent || '').trim()));
      return trigger ? (trigger.textContent || '').replace(/\\s+/g, ' ').trim() : null;
    })()`);
    if (label) return label;
    await sleep(250);
  }
  return null;
}

/** Read the quick effort label shown in the "Select model" entry (e.g. "High"); null when absent. */
export async function readEffortQuickItemLabel(client: CdpClient): Promise<string | null> {
  const label = await evalJson<string | null>(client, `(() => {
    const item = [...document.querySelectorAll('[role="menuitem"][aria-label="Select model"]')]
      .filter(el => el.offsetParent !== null)[0];
    if (!item) return null;
    const text = (item.textContent || '').replace(/\\s+/g, ' ').trim();
    return text.length > 0 && text.length <= 12 ? text : null;
  })()`);
  return label ?? null;
}

export interface EffortDescription {
  label: string;
  position: number;
  total: number;
}

/**
 * Read the slider description ("High, 3 of 4.") from the Power item's
 * aria-describedby spans: current level label plus 1-based position.
 */
export async function readEffortDescription(client: CdpClient): Promise<EffortDescription | null> {
  // The describedby spans regenerate after each step; retry briefly.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const parsed = await evalJson<EffortDescription | null>(client, `(() => {
      const item = (${FIND_EFFORT_POWER_ITEM});
      if (!item) return null;
      const ids = (item.getAttribute('aria-describedby') || '').split(/\\s+/).filter(Boolean);
      for (const id of ids) {
        const span = document.getElementById(id);
        const match = span && (span.textContent || '').trim().match(/^(.*?),\\s*(\\d+) of (\\d+)\\.$/);
        if (match) return { label: match[1].trim(), position: Number(match[2]), total: Number(match[3]) };
      }
      return null;
    })()`);
    if (parsed) return parsed;
    await sleep(250);
  }
  return null;
}

/** Positions (1-based) whose ticks are locked (gated for this account). */
export async function readLockedPositions(client: CdpClient, total: number): Promise<number[]> {
  const locked = await evalJson<number[]>(client, `(() => {
    const slider = (${FIND_SLIDER});
    if (!slider) return [];
    const track = slider.closest('[data-model-reasoning-effort-slider]');
    const ticks = track ? [...track.querySelectorAll('span[data-locked]')] : [];
    return ticks.map((tick, index) => tick.getAttribute('data-locked') === 'true' ? index + 1 : 0).filter(position => position > 0);
  })()`);
  return (locked ?? []).filter(position => position <= total);
}

export interface EffortSliderState {
  min: number;
  max: number;
  value: number;
}

export async function readEffortSlider(client: CdpClient): Promise<EffortSliderState | null> {
  const state = await evalJson<EffortSliderState | null>(client, `(() => {
    const slider = (${FIND_SLIDER});
    if (!slider) return null;
    const min = Number(slider.getAttribute('aria-valuemin'));
    const max = Number(slider.getAttribute('aria-valuemax'));
    const value = Number(slider.getAttribute('aria-valuenow'));
    if (![min, max, value].every(Number.isFinite) || max < min) return null;
    return { min, max, value };
  })()`);
  return state ?? null;
}

/**
 * Set the effort slider to a 1-based position by clicking the tick/track directly
 * (deterministic; arrow keys are intercepted by Radix menu navigation).
 * Returns the slider value after the click, or null when the slider is unavailable.
 */
export async function setEffortPosition(client: CdpClient, position: number): Promise<number | null> {
  // The slider detaches briefly while panels re-render; wait for it to come back.
  const deadline = Date.now() + 4_000;
  while ((await evalJson<boolean>(client, `(${FIND_SLIDER}) !== null`)) !== true) {
    if (Date.now() > deadline) return null;
    await sleep(250);
  }
  const coords = await evalJson<{ x: number; y: number } | null>(client, `(() => {
    const slider = (${FIND_SLIDER});
    if (!slider) return null;
    const track = slider.closest('[data-model-reasoning-effort-slider]')?.querySelector('[data-orientation="horizontal"]');
    const ticks = track ? [...track.querySelectorAll('span[data-locked]')] : [];
    const tick = ticks[${position - 1}] ?? null;
    const rect = (tick ?? track ?? slider).getBoundingClientRect();
    const x = tick ? rect.left + rect.width / 2 : rect.left + (rect.width * ${position - 0.5}) / ${Math.max(1, position)};
    return { x: Math.round(x), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  if (!coords || !Number.isFinite(coords.x) || coords.x <= 0) return null;
  await client.Input.dispatchMouseEvent({ type: "mouseMoved", x: coords.x, y: coords.y });
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
  // Poll until the value settles on the requested position.
  for (let i = 0; i < 10; i++) {
    await sleep(150);
    const after = await readEffortSlider(client);
    if (after && after.value === position - 1) return after.value;
  }
  const final = await readEffortSlider(client);
  return final ? final.value : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedLabel(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function effortTokenOf(token: string): string {
  return token.replace(/[^a-z]/gi, "").toLowerCase();
}

/**
 * Fast-path proof predicate: the composer trigger label proves the exact
 * model/effort selection only when the model label matches as a whole segment
 * ("GPT-5" cannot prove inside "GPT-5.6") and the remainder carries exactly the
 * requested effort level (aliases allowed). effort=null additionally requires no
 * effort token at all. Any doubt is false, keeping the exact-selection fallback.
 */
export function pickerTriggerProvesExact(triggerLabel: string, browserModelLabel: string, effort: string | null): boolean {
  const trigger = normalizedLabel(triggerLabel);
  const model = normalizedLabel(browserModelLabel);
  if (!trigger || !model) return false;
  const match = trigger.match(new RegExp(`(?<![\\w.])(${escapeRegExp(model)})(?![\\w.])`));
  if (!match || match.index === undefined) return false;
  const remainder = `${trigger.slice(0, match.index)} ${trigger.slice(match.index + match[0].length)}`;
  const tokens = remainder.split(/\s+/).map(effortTokenOf).filter(Boolean);
  if (effort === null) return !tokens.some(token => EFFORT_LABEL.test(token));
  return tokens.some(token => effortMatches(token, effort));
}

/** Read the composer picker trigger label without opening any menu; null when unreadable. */
export async function readPickerTriggerLabel(client: CdpClient): Promise<string | null> {
  // The trigger remounts while the composer settles; poll briefly, then give up
  // so the caller can fall back to the (slower) exact selection path.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const label = await evalJson<string | null>(client, `/* piPickerTrigger */ (() => {
      const slots = [...document.querySelectorAll('[data-composer-transition-slot="trailing"], [data-composer-transition-slot="end"]')];
      const triggers = slots.flatMap(slot => [...slot.querySelectorAll('button[aria-haspopup="menu"]')]).filter(el => el.offsetParent !== null);
      const trigger = triggers.find(el => ${EFFORT_LABEL.toString()}.test((el.textContent || '').trim())) ?? triggers[0];
      return trigger ? ((trigger.textContent || '').replace(/\\s+/g, ' ').trim() || null) : null;
    })()`);
    if (label) return label;
    await sleep(250);
  }
  return null;
}

/**
 * Proven-exact selection probe for the picker fast path. Reads only the composer
 * trigger; fails closed (false) on any doubt or probe error so selection always
 * falls back to the exact picker walk.
 */
export async function selectionIsProvenExact(client: CdpClient, browserModelLabel: string, effort: string | null): Promise<boolean> {
  try {
    const label = await readPickerTriggerLabel(client);
    return label !== null && pickerTriggerProvesExact(label, browserModelLabel, effort);
  } catch {
    return false;
  }
}

/**
 * Select exactly one model by visible label and confirm via aria-checked readback.
 * Fails closed: ambiguity or a rejected selection is an error.
 */
export async function selectModelExact(client: CdpClient, browserModelLabel: string): Promise<void> {
  if (!(await openModelPicker(client))) {
    throw new Error(`model_selection_failed: model picker did not open for "${browserModelLabel}".`);
  }
  const clicked = await syntheticClickElement(client, FIND_MODEL_ROW(browserModelLabel));
  if (!clicked) throw new Error(`model_selection_failed: "${browserModelLabel}" is not selectable for this account.`);
  // Picker closes on selection.
  await waitFor(client, `() => ![...document.querySelectorAll('[role="menuitemradio"]')].some(el => el.offsetParent !== null)`, 4_000);
  await sleep(400);
  // Confirm readback: reopen and require exactly one checked row with the label.
  if (!(await openModelPicker(client))) throw new Error(`model_confirmation_failed: picker did not reopen to confirm "${browserModelLabel}".`);
  const confirmed = await evalJson<boolean>(client, `(() => {
    const label = ${JSON.stringify(browserModelLabel)};
    const rows = [...document.querySelectorAll('[role="menuitemradio"]')]
      .filter(el => el.offsetParent !== null)
      .filter(el => (el.textContent || '').replace(/\\s+/g, ' ').trim() === label);
    return rows.length === 1 && rows[0].getAttribute('aria-checked') === 'true';
  })()`);
  await closeMenus(client);
  if (confirmed !== true) throw new Error(`model_confirmation_failed: "${browserModelLabel}" is not the confirmed selected model.`);
}

function effortMatches(actual: string, requested: string): boolean {
  const aliases: Record<string, string[]> = {
    instant: ["light"],
    light: ["instant"],
    high: ["heavy"],
    heavy: ["high"]
  };
  const actualLabel = actual.trim().toLowerCase();
  const requestedLabel = requested.trim().toLowerCase();
  return actualLabel === requestedLabel || aliases[requestedLabel]?.includes(actualLabel) === true;
}

export async function selectEffortExact(client: CdpClient, effort: string): Promise<void> {
  // Label-driven tick walk: slider positions are model-specific (totals and labels
  // vary), so positions mean nothing globally. Click each tick, read the authoritative
  // description on a reopened picker, and stop when it shows the target label.
  // Tick clicks apply and usually close the menu; every read happens on a fresh reopen.
  const isOpen = await evalJson<boolean>(client, `[...document.querySelectorAll('[role="menuitemradio"]')].some(el => el.offsetParent !== null)`);
  if (isOpen !== true && !(await openModelPicker(client))) {
    throw new Error(`effort_selection_failed: picker did not open for "${effort}".`);
  }
  const initial = await readEffortDescription(client);
  if (initial && effortMatches(initial.label, effort)) {
    await closeMenus(client);
    return; // already at target
  }
  let total = initial?.total ?? 0;
  let lastSlider: unknown;
  for (let round = 0; round < 3; round += 1) {
    for (let position = 1; position <= total; position += 1) {
      if ((await evalJson<boolean>(client, `(${FIND_SLIDER}) !== null`)) !== true) {
        await closeMenus(client);
        if (!(await openModelPicker(client))) break;
      }
      lastSlider = await setEffortPosition(client, position);
      const applied = await readEffortDescription(client);
      const desc = applied ?? (await (async () => {
        await closeMenus(client);
        if (!(await openModelPicker(client))) return null;
        return readEffortDescription(client);
      })());
      if (desc && effortMatches(desc.label, effort)) {
        await closeMenus(client);
        return;
      }
    }
    // Re-measure: totals can differ between renders.
    await closeMenus(client);
    if (await openModelPicker(client)) {
      total = (await readEffortDescription(client))?.total ?? total;
    }
  }
  throw new Error(`effort_selection_failed: could not reach "${effort}" (slider: ${JSON.stringify(lastSlider)}).`);
}
