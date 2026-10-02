import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assistantRevisionRequiresSerialization,
  captureAssistantTurn,
  readAssistantTurnRevision,
  readTurnState,
  type CdpClient,
  type TurnDomState
} from "../src/provider/page.js";
import { treeToMarkdown, type DomTreeNode } from "../src/provider/answer.js";
import { OpenAIWebRuntime } from "../src/provider/runtime.js";
import { ProviderTurnController } from "../src/provider/turn.js";
import type { HarnessConfig } from "../src/types.js";
import type { OpenAIWebModelDescriptor } from "../src/provider/types.js";

/**
 * Revision fingerprint regressions against the REAL probe/capture DOM
 * expressions: a tiny fake DOM implements just enough of querySelector/
 * querySelectorAll/attributes for the browser-side snippets shipped in
 * page.ts, and the actual expression strings are evaluated against it.
 * This pins two invariants:
 *
 * 1. The cheap probe and the atomic capture compute IDENTICAL revisions
 *    (same shared snippet), so a capture can never mismatch its own probe.
 * 2. A nested markup change that preserves text (ChatGPT re-rendering streamed
 *    inline code into a fenced block) changes the revision — the blind spot
 *    that let a live response settle as inline `const replySmoke = "ok";`
 *    while the DOM held the fenced block.
 * 3. Hidden stale busy chrome (aria-busy / loading-shimmer left mounted with
 *    display:none after completion) is ignored by ALL observation paths
 *    (readTurnState, probe, capture), while genuinely rendered markers — and
 *    the visible Stop control — still block completion.
 */

// ---------------------------------------------------------------------------
// Tiny fake DOM (no dependency): element/text nodes + subset selector engine
// ---------------------------------------------------------------------------

const FAKE_NODE = { ELEMENT_NODE: 1, TEXT_NODE: 3 } as const;

class FakeText {
  readonly nodeType = 3;
  readonly childNodes: never[] = [];
  constructor(public textContent: string) {}
}

interface AttrMatch {
  name: string;
  op?: string;
  value?: string;
}

interface ParsedSelector {
  tag?: string;
  attrs: AttrMatch[];
}

function parseSelector(selector: string): ParsedSelector[] {
  return selector.split(",").map(part => part.trim()).filter(Boolean).map(part => {
    const compound = part.match(/^([a-zA-Z][\w-]*)?((?:\[[^\]]*\])*)$/);
    if (!compound) throw new Error(`fixture DOM selector unsupported: ${part}`);
    const attrs: AttrMatch[] = [];
    const attrPattern = /\[([^\]~=^$*|]+)(?:([*^$]?=)("[^"]*"|'[^']*'|[^\]]*))?\]/g;
    let match: RegExpExecArray | null;
    while ((match = attrPattern.exec(compound[2] ?? "")) !== null) {
      const raw = match[3];
      const value = raw !== undefined ? raw.replace(/^["']|["']$/g, "") : undefined;
      attrs.push({ name: match[1]!.toLowerCase(), op: match[2], value });
    }
    return { tag: compound[1]?.toLowerCase(), attrs };
  });
}

function elementMatches(element: FakeElement, selector: string): boolean {
  return parseSelector(selector).some(alternative => {
    if (alternative.tag && element.tagName.toLowerCase() !== alternative.tag) return false;
    return alternative.attrs.every(attr => {
      const actual = attr.name === "class" ? element.className : element.getAttribute(attr.name);
      if (actual === null || actual === undefined) return false;
      if (attr.op === undefined || attr.op === null) return true;
      if (attr.op === "=") return actual === attr.value;
      if (attr.op === "*=") return actual.includes(attr.value ?? "");
      throw new Error(`fixture DOM attribute operator unsupported: ${attr.op}`);
    });
  });
}

function descendants(element: FakeElement): FakeElement[] {
  const found: FakeElement[] = [];
  const walk = (node: FakeElement): void => {
    for (const child of node.childrenNodes) {
      if (child instanceof FakeElement) {
        found.push(child);
        walk(child);
      }
    }
  };
  walk(element);
  return found;
}

class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly childrenNodes: Array<FakeElement | FakeText> = [];
  /** Rendered-visibility double: non-null by default, null for hidden fixtures. */
  offsetParent: object | null = {};
  /** Present only on fixed-position fixtures: rendered despite a null offsetParent. */
  getClientRects?: () => Array<object>;

  constructor(tagName: string, attrs: Record<string, string> = {}, options: { hidden?: boolean; fixed?: boolean } = {}) {
    this.tagName = tagName.toUpperCase();
    for (const [name, value] of Object.entries(attrs)) this.attributes.set(name.toLowerCase(), value);
    if (options.fixed) {
      this.offsetParent = null;
      this.getClientRects = () => [{}];
    } else if (options.hidden) {
      this.offsetParent = null;
    }
  }

  get className(): string { return this.attributes.get("class") ?? ""; }
  get childNodes(): Array<FakeElement | FakeText> { return this.childrenNodes; }
  get childElementCount(): number { return this.childrenNodes.filter(child => child.nodeType === 1).length; }
  getAttribute(name: string): string | null { return this.attributes.get(name.toLowerCase()) ?? null; }
  get textContent(): string { return this.childrenNodes.map(child => child.textContent).join(""); }
  querySelector(selector: string): FakeElement | null { return descendants(this).find(el => elementMatches(el, selector)) ?? null; }
  querySelectorAll(selector: string): FakeElement[] { return descendants(this).filter(el => elementMatches(el, selector)); }
}

class FakeDocument {
  private readonly all: FakeElement[];
  constructor(roots: FakeElement[]) { this.all = [...roots, ...roots.flatMap(descendants)]; }
  querySelector(selector: string): FakeElement | null { return this.all.find(el => elementMatches(el, selector)) ?? null; }
  querySelectorAll(selector: string): FakeElement[] { return this.all.filter(el => elementMatches(el, selector)); }
}

/** Fixture DOM spec: tag, optional text/href/class/attrs, children, visibility. */
interface DomSpec {
  tag: string;
  text?: string;
  href?: string;
  cls?: string;
  attrs?: Record<string, string>;
  children?: DomSpec[];
  /** Rendered as display:none: offsetParent null and no client rects. */
  hidden?: boolean;
  /** position:fixed: offsetParent null but client rects present (still rendered). */
  fixed?: boolean;
}

function buildElement(spec: DomSpec): FakeElement {
  const element = new FakeElement(spec.tag, {}, { hidden: spec.hidden, fixed: spec.fixed });
  if (spec.cls !== undefined) element.attributes.set("class", spec.cls);
  if (spec.href !== undefined) element.attributes.set("href", spec.href);
  for (const [name, value] of Object.entries(spec.attrs ?? {})) element.attributes.set(name, value);
  const kids = [...(spec.children ?? [])];
  if (spec.text !== undefined) kids.push({ tag: "#text", text: spec.text });
  for (const kid of kids) {
    element.childrenNodes.push(kid.tag === "#text" ? new FakeText(kid.text ?? "") : buildElement(kid));
  }
  return element;
}

/**
 * ChatGPT-shaped turn: [data-turn-id-container] wrapper > [data-turn-id]
 * assistant message > content div > blocks + copy action, so the REAL
 * readTurnState expression (turn-container binding + assistant role) runs
 * against the fixture exactly like the probe/capture expressions.
 */
function buildDocument(
  identity: string,
  dom: DomSpec | undefined,
  messageAttrs: Record<string, string> = {},
  extraRoots: FakeElement[] = []
): FakeDocument {
  const message = new FakeElement("div", { "data-turn-id": identity, "data-message-author-role": "assistant", ...messageAttrs });
  if (dom) message.childrenNodes.push(buildElement(dom));
  const container = new FakeElement("div", { "data-turn-id-container": identity });
  container.childrenNodes.push(message);
  return new FakeDocument([container, ...extraRoots]);
}

/** Message content wrapper: blocks plus the copy action button (excluded chrome). */
const contentSpec = (blocks: DomSpec[]): DomSpec => ({
  tag: "div",
  children: [...blocks, { tag: "button", attrs: { "data-testid": "copy-turn-action-button" } }]
});

/** Execute a CDP Runtime.evaluate expression against the fake DOM. */
function runExpression(expression: string, document: FakeDocument): unknown {
  const location = { href: "https://chatgpt.com/c/fixture-1" };
  const fn = new Function("document", "Node", "location", `"use strict"; return (${expression});`);
  return fn(document, FAKE_NODE, location);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CODE = 'const replySmoke = "ok";';
/** Streamed shape: inline `<code>` inside a paragraph, no language class. */
const inlineDom: DomSpec = contentSpec([{ tag: "p", children: [{ tag: "code", text: CODE }] }]);
/** Final shape: fenced `<pre><code>` with identical text and still no language class. */
const fencedDom: DomSpec = contentSpec([{ tag: "pre", children: [{ tag: "code", text: CODE }] }]);

// Real-browser final shape: ChatGPT keeps a persistent
// DIV[data-markdown-copy="code-block"] whose header (language label + copy
// buttons) is marked data-markdown-copy="exclude" and whose code lives in a
// DIV>CODE.whitespace-pre.block of spans — no PRE anywhere. The capture
// serializer must normalize it to fenced code, header-free, whitespace exact.
const SMOKE_CODE = 'function smoke() {\n  const replySmoke = "ok";\n\n  return replySmoke;\n}\n';
const expectedSmokeFence = "```typescript\n" + SMOKE_CODE.replace(/\n$/, "") + "\n```";
const codeHeaderSpec = (label: string): DomSpec => ({
  tag: "div",
  attrs: { "data-markdown-copy": "exclude" },
  children: [{ tag: "span", text: label }, { tag: "button", text: "Copy code" }, { tag: "svg" }]
});
const persistentBlockSpec: DomSpec = {
  tag: "div",
  attrs: { "data-markdown-copy": "code-block" },
  children: [
    codeHeaderSpec("typescript"),
    {
      tag: "div",
      children: [{
        tag: "code",
        cls: "whitespace-pre block language-typescript",
        children: [
          { tag: "span", text: "function smoke() {" },
          { tag: "span", text: '\n  const replySmoke = "ok";\n\n  return replySmoke;\n' },
          { tag: "span", text: "}" },
          { tag: "#text", text: "\n" }
        ]
      }]
    }
  ]
};
/** Persistent final shape: marked container, header UI, DIV>CODE (no PRE). */
const persistentFencedDom: DomSpec = contentSpec([persistentBlockSpec]);
/** Marked container that wraps a hydrated PRE>CODE — normalize either way. */
const innerPreFencedDom: DomSpec = contentSpec([{
  tag: "div",
  attrs: { "data-markdown-copy": "code-block" },
  children: [
    codeHeaderSpec("typescript"),
    { tag: "div", children: [{ tag: "pre", children: [{ tag: "code", cls: "language-typescript", text: SMOKE_CODE }] }] }
  ]
}]);
/** Hydrated equivalent: plain PRE>CODE with the same text and language. */
const hydratedFencedDom: DomSpec = contentSpec([{ tag: "pre", children: [{ tag: "code", cls: "language-typescript", text: SMOKE_CODE }] }]);
/** Same persistent DOM without the code-block marker: must NOT normalize. */
const unmarkedBlockDom: DomSpec = contentSpec([{
  tag: "div",
  children: [
    codeHeaderSpec("typescript"),
    {
      tag: "div",
      children: [{
        tag: "code",
        cls: "whitespace-pre block language-typescript",
        children: [
          { tag: "span", text: "function smoke() {" },
          { tag: "span", text: '\n  const replySmoke = "ok";\n\n  return replySmoke;\n' },
          { tag: "span", text: "}" },
          { tag: "#text", text: "\n" }
        ]
      }]
    }
  ]
}]);

function docClient(document: FakeDocument): CdpClient {
  return {
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => ({ result: { value: runExpression(expression, document) } })
    }
  } as never;
}

function staticDomClient(dom: DomSpec | undefined, messageAttrs: Record<string, string> = {}): CdpClient {
  return docClient(dom ? buildDocument("r1", dom, messageAttrs) : new FakeDocument([]));
}

// ---------------------------------------------------------------------------
// 1. Probe/capture revision identity and the nested same-text blind spot
// ---------------------------------------------------------------------------

test("probe and capture compute identical revisions on the same DOM", async () => {
  for (const dom of [inlineDom, fencedDom, persistentFencedDom]) {
    const client = staticDomClient(dom);
    const probe = await readAssistantTurnRevision(client, "r1");
    const capture = await captureAssistantTurn(client, "r1");
    assert.ok(probe && capture);
    assert.deepEqual(
      {
        textLength: probe.textLength,
        textChecksum: probe.textChecksum,
        childCount: probe.childCount,
        linkChecksum: probe.linkChecksum,
        languageKey: probe.languageKey,
        structureChecksum: probe.structureChecksum
      },
      capture.revision,
      "probe revision must equal the atomic capture revision"
    );
    assert.equal(probe.completionVisible, capture.completionVisible);
    assert.equal(probe.busy, capture.busy);
  }
});

test("same-text inline→fenced markup swap changes only the structure fingerprint", async () => {
  const inline = await captureAssistantTurn(staticDomClient(inlineDom), "r1");
  const fenced = await captureAssistantTurn(staticDomClient(fencedDom), "r1");
  assert.ok(inline && fenced);
  // Every legacy field is identical: this is exactly the old blind spot that
  // let the settled snapshot stay inline while the DOM held the fenced block.
  assert.equal(fenced.revision.textLength, inline.revision.textLength);
  assert.equal(fenced.revision.textChecksum, inline.revision.textChecksum);
  assert.equal(fenced.revision.childCount, inline.revision.childCount);
  assert.equal(fenced.revision.linkChecksum, inline.revision.linkChecksum);
  assert.equal(fenced.revision.languageKey, inline.revision.languageKey);
  // The nested structure fingerprint must catch the swap and gate reserialization.
  assert.notEqual(fenced.revision.structureChecksum, inline.revision.structureChecksum);
  assert.equal(
    assistantRevisionRequiresSerialization({ identity: "r1", revision: inline.revision }, "r1", fenced.revision),
    true
  );
  assert.equal(
    assistantRevisionRequiresSerialization({ identity: "r1", revision: fenced.revision }, "r1", fenced.revision),
    false
  );
  // And the serialized trees really do render differently (inline vs fenced).
  const inlineMarkdown = treeToMarkdown(inline.tree as DomTreeNode);
  const fencedMarkdown = treeToMarkdown(fenced.tree as DomTreeNode);
  assert.equal(inlineMarkdown, "`" + CODE + "`");
  assert.ok(fencedMarkdown.startsWith("```"), `fenced block expected, got: ${fencedMarkdown}`);
  assert.ok(fencedMarkdown.includes(CODE));
});

test("persistent data-markdown-copy block serializes to fenced code sans header", async () => {
  const capture = await captureAssistantTurn(staticDomClient(persistentFencedDom), "r1");
  assert.ok(capture);
  const markdown = treeToMarkdown(capture.tree as DomTreeNode);
  // Exact fenced markdown: interior indentation and the blank line survive
  // byte-for-byte, and the header UI (language label, copy button) never leaks.
  assert.equal(markdown, expectedSmokeFence);
  assert.ok(!markdown.includes("Copy"), `header UI leaked into: ${markdown}`);
});

test("persistent, inner-PRE, and hydrated fenced blocks serialize identically", async () => {
  const persistent = await captureAssistantTurn(staticDomClient(persistentFencedDom), "r1");
  const innerPre = await captureAssistantTurn(staticDomClient(innerPreFencedDom), "r1");
  const hydrated = await captureAssistantTurn(staticDomClient(hydratedFencedDom), "r1");
  assert.ok(persistent && innerPre && hydrated);
  assert.equal(treeToMarkdown(persistent.tree as DomTreeNode), expectedSmokeFence);
  assert.equal(treeToMarkdown(innerPre.tree as DomTreeNode), expectedSmokeFence);
  assert.equal(treeToMarkdown(hydrated.tree as DomTreeNode), expectedSmokeFence);
});

test("ordinary inline code remains inline beside a normalized container", async () => {
  const mixed: DomSpec = contentSpec([
    { tag: "p", children: [{ tag: "#text", text: "run " }, { tag: "code", text: CODE }, { tag: "#text", text: " now" }] },
    persistentBlockSpec
  ]);
  const capture = await captureAssistantTurn(staticDomClient(mixed), "r1");
  assert.ok(capture);
  assert.equal(
    treeToMarkdown(capture.tree as DomTreeNode),
    "run `" + CODE + "` now\n\n" + expectedSmokeFence,
    "inline CODE outside a marked container must stay inline"
  );
});

test("code-block marker flip and header churn stay revision-visible and invisible respectively", async () => {
  const persistent = await captureAssistantTurn(staticDomClient(persistentFencedDom), "r1");
  const unmarked = await captureAssistantTurn(staticDomClient(unmarkedBlockDom), "r1");
  assert.ok(persistent && unmarked);
  // Identical legacy fields; only the structure fingerprint sees the marker
  // flip, so a snapshot can never go stale on the attribute alone.
  assert.equal(unmarked.revision.textLength, persistent.revision.textLength);
  assert.equal(unmarked.revision.textChecksum, persistent.revision.textChecksum);
  assert.equal(unmarked.revision.languageKey, persistent.revision.languageKey);
  assert.notEqual(unmarked.revision.structureChecksum, persistent.revision.structureChecksum);
  assert.equal(assistantRevisionRequiresSerialization({ identity: "r1", revision: persistent.revision }, "r1", unmarked.revision), true);
  assert.equal(assistantRevisionRequiresSerialization({ identity: "r1", revision: persistent.revision }, "r1", persistent.revision), false);
  assert.notEqual(treeToMarkdown(unmarked.tree as DomTreeNode), expectedSmokeFence);
  // Header text churn (label length changes) must not move the structure fold
  // or the serialized tree: it is marked-exclude chrome in both expressions.
  const shorterHeader: DomSpec = contentSpec([{
    ...persistentBlockSpec,
    children: [codeHeaderSpec("ts"), persistentBlockSpec.children![1]!]
  }]);
  const churned = await captureAssistantTurn(staticDomClient(shorterHeader), "r1");
  assert.ok(churned);
  assert.equal(churned.revision.structureChecksum, persistent.revision.structureChecksum);
  assert.deepEqual(churned.tree, persistent.tree);
});

test("text redistribution across identical tags is caught by the structure fingerprint", async () => {
  const strongFirst: DomSpec = contentSpec([{ tag: "p", children: [{ tag: "strong", text: "ab" }, { tag: "#text", text: "c" }] }]);
  const strongLast: DomSpec = contentSpec([{ tag: "p", children: [{ tag: "#text", text: "a" }, { tag: "strong", text: "bc" }] }]);
  const first = await captureAssistantTurn(staticDomClient(strongFirst), "r1");
  const last = await captureAssistantTurn(staticDomClient(strongLast), "r1");
  assert.ok(first && last);
  assert.equal(last.revision.textLength, first.revision.textLength);
  assert.equal(last.revision.textChecksum, first.revision.textChecksum);
  assert.equal(last.revision.childCount, first.revision.childCount);
  assert.notEqual(last.revision.structureChecksum, first.revision.structureChecksum);
  assert.notEqual(treeToMarkdown(last.tree as DomTreeNode), treeToMarkdown(first.tree as DomTreeNode));
});

test("excluded action-bar chrome does not change the revision or serialized tree", async () => {
  const clean = contentSpec([{ tag: "p", text: "Hello" }]);
  const withChrome: DomSpec = {
    tag: "div",
    children: [
      { tag: "p", text: "Hello" },
      { tag: "button", attrs: { "data-testid": "copy-turn-action-button" } },
      { tag: "svg" },
      { tag: "span", cls: "sr-only" },
      { tag: "div", cls: "loading-shimmer" }
    ]
  };
  const cleanCapture = await captureAssistantTurn(staticDomClient(clean), "r1");
  const chromeCapture = await captureAssistantTurn(staticDomClient(withChrome), "r1");
  assert.ok(cleanCapture && chromeCapture);
  assert.deepEqual(chromeCapture.revision, cleanCapture.revision);
  assert.deepEqual(chromeCapture.tree, cleanCapture.tree);
});

test("probe returns undefined when the bound message is gone", async () => {
  const probe = await readAssistantTurnRevision(staticDomClient(undefined), "r1");
  assert.equal(probe, undefined);
});

// ---------------------------------------------------------------------------
// 1b. Visibility-aware busy semantics across all three observation paths
// ---------------------------------------------------------------------------

/** Completed reply paragraph plus busy chrome ChatGPT left mounted after completion. */
const replyDoneSpec: DomSpec = { tag: "p", text: "Done." };
/** Hidden stale aria-busy marker (display:none subtree → offsetParent null). */
const hiddenAriaBusyDom: DomSpec = contentSpec([replyDoneSpec, { tag: "div", attrs: { "aria-busy": "true" }, hidden: true }]);
/** Hidden stale loading-shimmer node. */
const hiddenShimmerDom: DomSpec = contentSpec([replyDoneSpec, { tag: "div", cls: "loading-shimmer h-2 w-40", hidden: true }]);
/** Genuinely rendered busy markers: visible and position:fixed variants. */
const visibleAriaBusyDom: DomSpec = contentSpec([replyDoneSpec, { tag: "div", attrs: { "aria-busy": "true" } }]);
const visibleShimmerDom: DomSpec = contentSpec([replyDoneSpec, { tag: "div", cls: "loading-shimmer h-2 w-40" }]);
/** position:fixed marker: offsetParent is null even while rendered. */
const fixedShimmerDom: DomSpec = contentSpec([replyDoneSpec, { tag: "div", cls: "loading-shimmer h-2 w-40", fixed: true }]);

const HIDDEN_STALE_BUSY_DOMS: DomSpec[] = [hiddenAriaBusyDom, hiddenShimmerDom];
const VISIBLE_BUSY_DOMS: DomSpec[] = [visibleAriaBusyDom, visibleShimmerDom, fixedShimmerDom];

test("readTurnState ignores hidden stale aria-busy/loading-shimmer chrome", async () => {
  for (const dom of HIDDEN_STALE_BUSY_DOMS) {
    const state = await readTurnState(staticDomClient(dom));
    assert.equal(state.busy, false, "hidden stale busy chrome must not report busy");
    assert.equal(state.completionActionVisible, true, "completed reply keeps its visible copy action");
    assert.equal(state.completionResponseIdentity, "r1");
    assert.equal(state.stopVisible, false);
    assert.deepEqual(state.responseIdentities, ["r1"]);
  }
});

test("readTurnState stays busy for rendered markers and message-level aria-busy", async () => {
  for (const dom of VISIBLE_BUSY_DOMS) {
    const state = await readTurnState(staticDomClient(dom));
    assert.equal(state.busy, true, "a rendered busy marker must keep blocking completion");
  }
  // The bound message's own aria-busy marks the whole turn: authoritative
  // regardless of descendant chrome.
  const messageLevel = await readTurnState(staticDomClient(contentSpec([replyDoneSpec]), { "aria-busy": "true" }));
  assert.equal(messageLevel.busy, true);
});

test("probe and capture agree: hidden stale busy chrome ignored, rendered markers busy", async () => {
  for (const dom of HIDDEN_STALE_BUSY_DOMS) {
    const client = staticDomClient(dom);
    const probe = await readAssistantTurnRevision(client, "r1");
    const capture = await captureAssistantTurn(client, "r1");
    assert.ok(probe && capture);
    assert.equal(probe.busy, false, "probe must ignore hidden stale busy chrome");
    assert.equal(capture.busy, false, "atomic capture must ignore hidden stale busy chrome");
    assert.equal(probe.busy, capture.busy);
    assert.equal(probe.completionVisible, true);
    assert.equal(capture.completionVisible, true);
  }
  for (const dom of VISIBLE_BUSY_DOMS) {
    const client = staticDomClient(dom);
    const probe = await readAssistantTurnRevision(client, "r1");
    const capture = await captureAssistantTurn(client, "r1");
    assert.ok(probe && capture);
    assert.equal(probe.busy, true, "probe must honor a rendered busy marker");
    assert.equal(capture.busy, true, "atomic capture must honor a rendered busy marker");
    assert.equal(probe.busy, capture.busy);
  }
});

test("visible Stop stays authoritative busy evidence independent of busy markers", async () => {
  // Calm completed message (only hidden stale chrome) plus a VISIBLE stop
  // button: the busy flags must read false while stopVisible stays true — the
  // stop control is independent, visibility-checked evidence of its own.
  const stop = new FakeElement("button", { "data-testid": "stop-button" });
  const client = docClient(buildDocument("r1", hiddenAriaBusyDom, {}, [stop]));
  const state = await readTurnState(client);
  assert.equal(state.busy, false);
  assert.equal(state.stopVisible, true);
  const capture = await captureAssistantTurn(client, "r1");
  assert.ok(capture);
  assert.equal(capture.busy, false);
  assert.equal(capture.stopVisible, true);
  // A hidden stop control is not busy evidence either.
  const hiddenStop = new FakeElement("button", { "data-testid": "stop-button" }, { hidden: true });
  const calm = await readTurnState(docClient(buildDocument("r1", hiddenAriaBusyDom, {}, [hiddenStop])));
  assert.equal(calm.busy, false);
  assert.equal(calm.stopVisible, false);
});

// ---------------------------------------------------------------------------
// 2. Watch-loop regression: the real expressions drive the settle loop
// ---------------------------------------------------------------------------

const descriptor: OpenAIWebModelDescriptor = {
  id: "gpt-5-6-luna-high",
  displayName: "GPT-5.6 Luna",
  browserModelLabel: "GPT-5.6 Luna",
  effort: "High",
  source: "live",
  discoveredAt: new Date().toISOString(),
  selectable: true,
  capabilityState: "unknown"
};

function baseConfig(dir: string, overrides: { stallTimeoutMs: number; turnTimeoutMs: number }): HarnessConfig {
  return {
    mcpHost: "127.0.0.1",
    mcpPort: 8765,
    mcpPath: "/mcp",
    publicMcpUrl: undefined,
    stateDir: dir,
    browser: "dia",
    browserBinary: undefined,
    browserProfileDir: join(dir, "dia-profile"),
    browserStartupTimeoutMs: 10_000,
    cdpHost: "127.0.0.1",
    cdpPort: 9222,
    chatgptUrl: "https://chatgpt.com/",
    chatgptAppName: "Pi Workspace",
    browserAutoAttachApp: true,
    verbose: false,
    maxReadLines: 500,
    maxFileBytes: 1_000_000,
    tunnelBinary: "tunnel-client",
    tunnelProfile: "pi-planner",
    tunnelHealthPort: 8080,
    tunnelStartupTimeoutMs: 10_000,
    catalogSuccessTtlMs: 86_400_000,
    catalogFailureRetryMs: 180_000,
    providerTurnTimeoutMs: overrides.turnTimeoutMs,
    providerStallTimeoutMs: overrides.stallTimeoutMs,
    providerToolWaitMs: 10_000,
    harnessAutoApproveHerdrRun: false
  };
}

function domState(overrides: Partial<TurnDomState>): TurnDomState {
  return {
    turnIdentities: [],
    userIdentities: [],
    responseIdentities: [],
    completionActionVisible: false,
    stopVisible: false,
    busy: false,
    url: "https://chatgpt.com/c/conv-1",
    ...overrides
  };
}

interface DomFrame {
  state: TurnDomState;
  dom?: DomSpec;
}

/**
 * Fake CDP client that executes the REAL probe/capture expressions against a
 * fake DOM rebuilt from the current frame's spec; readTurnState is served from
 * the frame like the other watch tests.
 */
function domWatchClient(frames: DomFrame[]) {
  if (frames.length === 0) throw new Error("script needs at least one frame");
  let current: DomFrame = frames[0]!;
  let polls = 0;
  let revisionProbes = 0;
  let serializations = 0;
  const pollTimestamps: number[] = [];
  const client = {
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("data-turn-id-container")) {
          polls += 1;
          pollTimestamps.push(Date.now());
          current = frames.length > 1 ? frames.shift()! : frames[0]!;
          return { result: { value: current.state } };
        }
        if (expression.includes("piRevisionProbe")) {
          revisionProbes += 1;
          if (!current.dom) return { result: { value: null } };
          return { result: { value: runExpression(expression, buildDocument("r1", current.dom)) } };
        }
        if (expression.includes("piAtomicTurnCapture")) {
          serializations += 1;
          if (!current.dom) return { result: { value: null } };
          return { result: { value: runExpression(expression, buildDocument("r1", current.dom)) } };
        }
        return { result: { value: undefined } };
      }
    }
  };
  return {
    client,
    pollTimestamps,
    pollCount: () => polls,
    revisionProbeCount: () => revisionProbes,
    serializeCount: () => serializations
  };
}

function makeDomWatchHarness(
  cfg: HarnessConfig,
  frames: DomFrame[],
  handlers?: { onText?: (fullTextSoFar: string) => void }
) {
  const double = domWatchClient(frames);
  const runtime = new OpenAIWebRuntime({
    config: cfg,
    catalog: { resolve: () => descriptor, models: [descriptor] } as never,
    ensureBrowser: async () => {},
    getBranchKey: () => "branch-1"
  });
  (runtime as unknown as { conversation: unknown }).conversation = {
    targetId: "target-1",
    descriptorKey: "GPT-5.6 Luna::High",
    branchKey: "branch-1",
    leaseKey: "lease",
    epoch: 0,
    bootstrapped: true,
    syncedMessageCount: 0,
    client: double.client
  };
  const controller = new ProviderTurnController(descriptor, "target-1", "turn-1", "fp", cfg.providerTurnTimeoutMs, cfg.providerStallTimeoutMs);
  controller.transition("submitted");
  controller.transition("generating");
  return {
    controller,
    ...double,
    run: (options: { signal?: AbortSignal } = {}) => (runtime as unknown as {
      watch: (c: ProviderTurnController, h: unknown, o: { signal?: AbortSignal }, b: TurnDomState) => Promise<{ kind: string; error?: string; markdown?: string }>
    }).watch(controller, handlers ?? {}, options, domState({}))
  };
}

test("nested same-text markup change mid-settle reserializes and completes with the fenced markdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-revision-dom-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 60_000 });
    const emitted: string[] = [];
    const completed = (dom: DomSpec): DomFrame => ({
      state: domState({ responseIdentities: ["r1"], completionActionVisible: true, completionResponseIdentity: "r1" }),
      dom
    });
    // The live response streams inline code for three polls, then ChatGPT
    // re-renders the same text as a fenced block — identical legacy revision
    // fields, different nested structure. The real probe expression must catch
    // the swap, reserialize, stream the fenced markdown, restart the settle
    // window, and complete on the fenced block (never the stale inline text).
    const h = makeDomWatchHarness(
      cfg,
      [
        completed(inlineDom),
        completed(inlineDom),
        completed(inlineDom),
        completed(fencedDom), // markup swap lands here
        completed(fencedDom),
        completed(fencedDom),
        completed(fencedDom)
      ],
      { onText: (full) => emitted.push(full) }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    const expectedFenced = treeToMarkdown((await captureAssistantTurn(staticDomClient(fencedDom), "r1"))!.tree as DomTreeNode);
    assert.equal(outcome.markdown, expectedFenced);
    assert.ok(outcome.markdown.startsWith("```"), `fenced completion expected, got: ${outcome.markdown}`);
    assert.deepEqual(emitted, ["`" + CODE + "`", expectedFenced], "the swap must reset settling and stream the fenced text");
    // First sight (inline), reserialization on the structure change (fenced),
    // and the final atomic verification: exactly three full captures.
    assert.equal(h.serializeCount(), 3);
    assert.equal(h.revisionProbeCount(), h.pollCount());
    assert.equal(h.pollCount(), 7);
    // Completion must trail the swap poll by a full fresh semantic settle window.
    const swapPoll = h.pollTimestamps[3]!;
    const last = h.pollTimestamps[h.pollTimestamps.length - 1]!;
    assert.ok(last - swapPoll >= 1_250, `post-swap settle must span the full window, got ${last - swapPoll}ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stable reply with only hidden stale busy chrome completes in the normal settle window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-revision-hidden-busy-"));
  try {
    // The turn timeout bounds the baseline failure: without visibility-aware
    // busy semantics the REAL probe expression reports busy forever, so the
    // loop touches progress until the hard timeout instead of settling.
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 8_000 });
    const emitted: string[] = [];
    const calmWithHiddenChrome = (dom: DomSpec): DomFrame => ({
      state: domState({ responseIdentities: ["r1"], completionActionVisible: true, completionResponseIdentity: "r1" }),
      dom
    });
    // Both stale-marker shapes (hidden aria-busy, then hidden shimmer) sit
    // inside a stable completed reply whose visible copy action is present.
    // The real expressions must read them as calm: completion happens after
    // the normal semantic settle window, not after touching progress forever.
    const h = makeDomWatchHarness(
      cfg,
      [
        calmWithHiddenChrome(hiddenAriaBusyDom),
        calmWithHiddenChrome(hiddenAriaBusyDom),
        calmWithHiddenChrome(hiddenAriaBusyDom),
        calmWithHiddenChrome(hiddenAriaBusyDom),
        calmWithHiddenChrome(hiddenShimmerDom),
        calmWithHiddenChrome(hiddenShimmerDom),
        calmWithHiddenChrome(hiddenShimmerDom),
        calmWithHiddenChrome(hiddenShimmerDom)
      ],
      { onText: (full) => emitted.push(full) }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.equal(outcome.markdown, "Done.");
    assert.deepEqual(emitted, ["Done."]);
    // Normal semantic settle window only: a handful of calm polls and exactly
    // two full captures (first sight + final atomic verification). Baseline
    // behavior never completed here — it polled busy until hard timeout.
    assert.ok(h.pollCount() <= 6, `hidden chrome must not stretch the window, got ${h.pollCount()} polls`);
    assert.equal(h.serializeCount(), 2);
    assert.equal(h.revisionProbeCount(), h.pollCount());
    assert.equal(h.controller.state, "completed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visible busy marker still blocks settling; completion re-earned after it hides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-revision-visible-busy-"));
  try {
    const cfg = baseConfig(dir, { stallTimeoutMs: 5_000, turnTimeoutMs: 30_000 });
    const emitted: string[] = [];
    const frame = (dom: DomSpec): DomFrame => ({
      state: domState({ responseIdentities: ["r1"], completionActionVisible: true, completionResponseIdentity: "r1" }),
      dom
    });
    // The shimmer renders for two polls (the real probe expression must keep
    // reporting busy and block any settle window), then ChatGPT hides the
    // stale chrome: completion must be re-earned over a full fresh window
    // measured from the first calm poll — never inherited from busy polls.
    const h = makeDomWatchHarness(
      cfg,
      [
        frame(visibleShimmerDom),
        frame(visibleShimmerDom),
        frame(hiddenShimmerDom),
        frame(hiddenShimmerDom),
        frame(hiddenShimmerDom),
        frame(hiddenShimmerDom),
        frame(hiddenShimmerDom),
        frame(hiddenShimmerDom)
      ],
      { onText: (full) => emitted.push(full) }
    );
    const outcome = await h.run();
    assert.equal(outcome.kind, "completed", outcome.error);
    assert.equal(outcome.markdown, "Done.");
    assert.deepEqual(emitted, ["Done."], "busy polls stream once; hiding chrome opens the window");
    assert.equal(h.serializeCount(), 2);
    const last = h.pollTimestamps[h.pollTimestamps.length - 1]!;
    const firstCalm = h.pollTimestamps[2]!;
    assert.ok(last - firstCalm >= 1_250, `completion must earn a full fresh window after the marker hides, got ${last - firstCalm}ms`);
    assert.ok(h.pollCount() >= 5, `visible busy must delay completion past its own polls, got ${h.pollCount()} polls`);
    assert.equal(h.controller.state, "completed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
