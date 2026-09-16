import CDP from "chrome-remote-interface";
import type { HarnessConfig } from "../types.js";
import { extractConversationId, isTemporaryChatUrl, toTemporaryChatUrl } from "../browser/chatgpt.js";

/**
 * Reusable low-level ChatGPT page primitives shared by catalog discovery and
 * provider turns. Never touches browser cookies/auth storage.
 */

export type CdpClient = Awaited<ReturnType<typeof CDP>>;
type Runtime = CdpClient["Runtime"];

export const COMPLETION_ACTION_SELECTOR = 'button[data-testid="copy-turn-action-button"]';
export const STOP_BUTTON_SELECTOR = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop streaming"]',
  'button[aria-label*="Stop"]'
].join(", ");

export const ASSISTANT_MESSAGE_SELECTOR = '[data-turn="assistant"], [data-message-author-role="assistant"]';
export const COMPOSER_SELECTOR = '[contenteditable="true"]';

/** DOM snapshot of provider turn progress; contains no prompt/response bodies. */
export interface TurnDomState {
  /** Stable ChatGPT logical IDs; display indexes are intentionally not used for binding. */
  turnIdentities: string[];
  userIdentities: string[];
  responseIdentities: string[];
  completionActionVisible: boolean;
  stopVisible: boolean;
  busy: boolean;
  url: string;
}

export async function newChatGptTarget(config: HarnessConfig): Promise<{ id?: string }> {
  return CDP.New({ host: config.cdpHost, port: config.cdpPort, url: toTemporaryChatUrl(config.chatgptUrl) });
}

export async function attach(config: HarnessConfig, targetId: string): Promise<CdpClient> {
  return CDP({ host: config.cdpHost, port: config.cdpPort, target: targetId });
}

export async function listTargets(config: HarnessConfig): Promise<Array<{ id?: string; url?: string }>> {
  return CDP.List({ host: config.cdpHost, port: config.cdpPort }) as Promise<Array<{ id?: string; url?: string }>>;
}

export async function enablePage(client: CdpClient): Promise<void> {
  await Promise.all([client.Page.enable(), client.Runtime.enable()]);
}

/** Poll until evalFn (a JS expression or arrow function) returns true. */
export async function waitFor(client: CdpClient, evalFn: string, timeoutMs: number, intervalMs = 250): Promise<boolean> {
  // Handle both plain expressions and arrow functions: call it if it is a function.
  const expression = `Boolean((() => { const f = (${evalFn}); return typeof f === "function" ? f() : f; })())`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await client.Runtime.evaluate({ expression, returnByValue: true });
      if (result.exceptionDetails) { /* expression error: retry until deadline */ }
      else if (result.result.value === true) return true;
    } catch { /* execution context can be transiently destroyed during navigation */ }
    await sleep(intervalMs);
  }
  return false;
}

export async function evalJson<T>(client: CdpClient, expression: string): Promise<T | undefined> {
  // Accept both plain expressions and arrow functions: call it if it evaluates to a function.
  const wrapped = `(() => { const v = (${expression}); return typeof v === "function" ? v() : v; })()`;
  const result = await client.Runtime.evaluate({ expression: wrapped, returnByValue: true });
  return result.result.value as T | undefined;
}

export async function currentUrl(client: CdpClient): Promise<string> {
  return (await evalJson<string>(client, "location.href")) ?? "";
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const COMPOSER_READY_FN = `() => [...document.querySelectorAll('${COMPOSER_SELECTOR}')].some(el => el.offsetParent !== null)`;

export async function waitForComposer(client: CdpClient, timeoutMs = 60_000): Promise<void> {
  if (!(await waitFor(client, COMPOSER_READY_FN, timeoutMs))) {
    throw new Error("ChatGPT composer not found. Ensure the configured Browser/CDP profile is logged in to chatgpt.com.");
  }
}

export async function focusComposer(client: CdpClient): Promise<void> {
  // The composer remounts during UI settle; retry briefly before giving up.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const ok = await evalJson<boolean>(client, `(() => {
      const el = [...document.querySelectorAll('${COMPOSER_SELECTOR}')].filter(el => el.offsetParent !== null).at(-1);
      if (!el) return false;
      el.focus();
      return true;
    })()`);
    if (ok === true) return;
    await sleep(250);
  }
  throw new Error("Unable to focus ChatGPT composer");
}

/** Submit text via the composer. Caller must already have confirmed fresh state when required. */
export async function submitPrompt(client: CdpClient, text: string): Promise<void> {
  await focusComposer(client);
  const hasExistingText = await evalJson<boolean>(client, `() => {
    const el = [...document.querySelectorAll('${COMPOSER_SELECTOR}')].filter(el => el.offsetParent !== null).at(-1);
    return Boolean(el && (el.textContent || '').trim().length > 0);
  }`);
  if (hasExistingText) {
    await clearComposer(client);
  }
  await client.Input.insertText({ text });
  await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

export async function readTurnState(client: CdpClient): Promise<TurnDomState> {
  const state = await evalJson<TurnDomState>(client, `() => {
    const containers = [...document.querySelectorAll('[data-turn-id-container]')].filter(el =>
      !el.parentElement?.closest('[data-turn-id-container]'));
    const turnIdentities = containers.map(el => el.getAttribute('data-turn-id-container')).filter(Boolean);
    const identities = (selector) => [...document.querySelectorAll(selector)]
      .map(el => el.getAttribute('data-turn-id')).filter(Boolean);
    const userIdentities = identities('[data-turn-id][data-message-author-role="user"], [data-turn-id][data-turn="user"]');
    const responseIdentities = identities('[data-turn-id][data-message-author-role="assistant"], [data-turn-id][data-turn="assistant"]');
    if (turnIdentities.some(id => typeof id !== 'string') || new Set(turnIdentities).size !== turnIdentities.length
      || [...userIdentities, ...responseIdentities].some(id => !turnIdentities.includes(id))) {
      throw new Error('ChatGPT conversation turn has no stable logical identity');
    }
    const raw = [...document.querySelectorAll('${ASSISTANT_MESSAGE_SELECTOR}')];
    const messages = raw.filter(el => !raw.some(other => other !== el && other.contains(el)));
    const last = messages.at(-1);
    const stop = [...document.querySelectorAll('${STOP_BUTTON_SELECTOR}')].find(el => el.offsetParent !== null);
    const completion = [...document.querySelectorAll('${COMPLETION_ACTION_SELECTOR}')].find(el => el.offsetParent !== null);
    const busy = last ? Boolean(
      last.querySelector('[aria-busy="true"], [class*="loading-shimmer"]') ||
      last.getAttribute('aria-busy') === 'true'
    ) : false;

    return {
      turnIdentities,
      userIdentities,
      responseIdentities,
      completionActionVisible: Boolean(completion),
      stopVisible: Boolean(stop),
      busy,
      url: location.href
    };
  }`);
  return state ?? { turnIdentities: [], userIdentities: [], responseIdentities: [], completionActionVisible: false, stopVisible: false, busy: false, url: "" };
}

export async function waitForConversationUrl(client: CdpClient, timeoutMs = 10_000): Promise<string> {
  let url = await currentUrl(client);
  if (isTemporaryChatUrl(url)) return url;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    url = await currentUrl(client);
    if (isTemporaryChatUrl(url)) return url;
    if (extractConversationId(url)) return url;
    await sleep(250);
  }
  return url;
}

/** Attempt ChatGPT Stop generation. Returns whether a visible stop control was clicked. */
export async function stopGeneration(client: CdpClient): Promise<boolean> {
  return (await evalJson<boolean>(client, `() => {
    const stop = [...document.querySelectorAll('${STOP_BUTTON_SELECTOR}')].find(el => el.offsetParent !== null);
    if (!stop) return false;
    stop.click();
    return true;
  }`)) === true;
}

/** Check whether the target page is in Temporary Chat mode. */
export async function isTemporaryChat(client: CdpClient): Promise<boolean> {
  const info = await evalJson<{
    hasTurnOff: boolean;
    hasSaveChat: boolean;
    hasTempParam: boolean;
    isNormalChatUrl: boolean;
  }>(client, `() => {
    const hasTurnOff = Boolean(document.querySelector('button[aria-label="Turn off temporary chat"]'));
    const hasSaveChat = Boolean(document.querySelector('button[aria-label="Save chat"]'));
    const hasTempParam = new URL(location.href).searchParams.get("temporary-chat") === "true";
    const isNormalChatUrl = /\\/c\\/[^/?#]+/i.test(location.href);
    return {
      hasTurnOff,
      hasSaveChat,
      hasTempParam,
      isNormalChatUrl
    };
  }`);
  if (!info) return false;
  if (info.isNormalChatUrl) return false;
  return info.hasTurnOff || info.hasSaveChat || info.hasTempParam;
}

/** Ensure the target page is in Temporary Chat mode. Fails closed if cannot be confirmed. */
export async function ensureTemporaryChat(client: CdpClient, chatgptUrl?: string): Promise<boolean> {
  if (await isTemporaryChat(client)) return true;

  // 1. Try clicking visible "Temporary chat" toggle button if present
  const clicked = await evalJson<boolean>(client, `() => {
    const off = [...document.querySelectorAll('button[aria-label="Temporary chat"]')].find(el => el.offsetParent !== null);
    if (!off) return false;
    off.click();
    return true;
  }`);
  if (clicked === true) {
    const confirmed = await waitFor(client, `() => {
      const hasTurnOff = Boolean(document.querySelector('button[aria-label="Turn off temporary chat"]'));
      const hasSave = Boolean(document.querySelector('button[aria-label="Save chat"]'));
      return hasTurnOff || hasSave;
    }`, 3_000);
    if (confirmed) return true;
  }

  // 2. If still not in temporary chat, navigate directly to temporary chat URL
  const targetUrl = toTemporaryChatUrl(chatgptUrl ?? "https://chatgpt.com/");
  await client.Page.navigate({ url: targetUrl });
  await waitForComposer(client);

  return waitFor(client, `() => {
    const hasTurnOff = Boolean(document.querySelector('button[aria-label="Turn off temporary chat"]'));
    const hasSaveChat = Boolean(document.querySelector('button[aria-label="Save chat"]'));
    const hasTempParam = new URL(location.href).searchParams.get("temporary-chat") === "true";
    const isNormalChatUrl = /\\/c\\/[^/?#]+/i.test(location.href);
    return !isNormalChatUrl && (hasTurnOff || hasSaveChat || hasTempParam);
  }`, 5_000);
}

/** Best-effort Temporary Chat enable; backwards-compatible alias delegating to ensureTemporaryChat. */
export async function enableTemporaryChatBestEffort(client: CdpClient): Promise<boolean> {
  return ensureTemporaryChat(client);
}

/** Clear the composer text (used when a leftover draft must not leak into the next submit). */
export async function clearComposer(client: CdpClient): Promise<void> {
  await focusComposer(client);
  const modifier = process.platform === "darwin" ? 4 : 2;
  await client.Input.dispatchKeyEvent({ type: "keyDown", modifiers: modifier, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
  await client.Input.dispatchKeyEvent({ type: "keyUp", modifiers: modifier, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
  await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await evalJson<boolean>(client, `() => {
    const el = [...document.querySelectorAll('${COMPOSER_SELECTOR}')].filter(el => el.offsetParent !== null).at(-1);
    if (!el) return false;
    el.innerHTML = '<p><br></p>';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }`);
}

/**
 * Serialize the assistant message at the given index into a JSON tree (answer.ts
 * converts it to markdown in Node). Index-based so ownership is decided by the caller.
 */
export async function serializeAssistantTurn(client: CdpClient, identity: string): Promise<unknown | undefined> {
  return evalJson(client, `() => {
    const wanted = ${JSON.stringify(identity)};
    const message = document.querySelector('[data-turn-id=' + JSON.stringify(wanted) + ']');
    if (!message) return undefined;
    const isExcluded = (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return false;
      const tag = node.tagName;
      if (tag === 'BUTTON' || tag === 'SVG' || tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT') return true;
      if (node.getAttribute && (node.getAttribute('aria-busy') === 'true' || node.getAttribute('data-testid') === 'tool-call-status')) return true;
      const cls = typeof node.className === 'string' ? node.className : '';
      return cls.includes('tool-message') || cls.includes('loading-shimmer') || cls.includes('agent-turn-status') || cls.includes('sr-only');
    };
    const languageOf = pre => { const code = pre.querySelector('code[class*="language-"]'); const match = code && (code.className.match(/language-([\\w+#-]+)/) || [])[1]; return match || undefined; };
    const serialize = (node, inPre) => {
      if (node.nodeType === Node.TEXT_NODE) return { tag: '#text', text: node.textContent };
      if (node.nodeType !== Node.ELEMENT_NODE || (!inPre && isExcluded(node))) return null;
      const tag = node.tagName.toLowerCase();
      const children = [...node.childNodes].map(child => serialize(child, inPre || node.tagName === 'PRE')).filter(Boolean);
      const entry = { tag, children };
      if (node.tagName === 'A' && node.getAttribute('href')) entry.href = node.getAttribute('href');
      if (node.tagName === 'PRE') entry.language = languageOf(node);
      if (node.tagName === 'CODE' && !node.querySelector('code')) entry.text = node.textContent;
      return entry;
    };
    return serialize(message, false);
  }`);
}

/** Compatibility serializer; callers binding turns should use serializeAssistantTurn. */
export async function serializeAssistantMessage(client: CdpClient, index: number): Promise<unknown | undefined> {
  return evalJson(client, `() => {
    const raw = [...document.querySelectorAll('${ASSISTANT_MESSAGE_SELECTOR}')];
    const messages = raw.filter(el => !raw.some(other => other !== el && other.contains(el)));
    const message = messages.at(${index});
    if (!message) return undefined;
    const isExcluded = (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return false;
      const tag = node.tagName;
      if (tag === 'BUTTON' || tag === 'SVG' || tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT') return true;
      if (node.getAttribute && (node.getAttribute('aria-busy') === 'true' || node.getAttribute('data-testid') === 'tool-call-status')) return true;
      const cls = typeof node.className === 'string' ? node.className : '';
      if (cls.includes('tool-message') || cls.includes('loading-shimmer') || cls.includes('agent-turn-status') || cls.includes('sr-only')) return true;
      if (tag === 'H4' && (node.textContent || '').trim().toLowerCase().startsWith('chatgpt said')) return true;
      return false;
    };
    const blockTags = new Set(['P','H1','H2','H3','H4','H5','H6','UL','OL','LI','PRE','BLOCKQUOTE','TABLE','THEAD','TBODY','TR','TH','TD','HR','DIV','SECTION','ARTICLE']);
    const inlineTags = new Set(['STRONG','B','EM','I','CODE','A','BR','SPAN']);
    const languageOf = pre => {
      const code = pre.querySelector('code[class*="language-"]');
      const match = code && (code.className.match(/language-([\w+#-]+)/) || [])[1];
      return match || undefined;
    };
    const serialize = (node, inPre) => {
      if (node.nodeType === Node.TEXT_NODE) return { tag: '#text', text: node.textContent };
      if (node.nodeType !== Node.ELEMENT_NODE) return null;
      if (!inPre && isExcluded(node)) return null;
      const tag = node.tagName.toLowerCase();
      const children = [...node.childNodes].map(child => serialize(child, inPre || node.tagName === 'PRE')).filter(Boolean);
      const entry = { tag, children };
      if (node.tagName === 'A' && node.getAttribute('href')) entry.href = node.getAttribute('href');
      if (node.tagName === 'PRE') entry.language = languageOf(node);
      if (node.tagName === 'CODE' && !node.querySelector('code')) entry.text = node.textContent;
      return entry;
    };
    return serialize(message, false);
  }`);
}

export { Runtime };
