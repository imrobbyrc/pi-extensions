import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assistantRevisionRequiresSerialization,
  captureAssistantTurn,
  readAssistantTurnRevision,
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
  readonly offsetParent: object | null = {};

  constructor(tagName: string, attrs: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    for (const [name, value] of Object.entries(attrs)) this.attributes.set(name.toLowerCase(), value);
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

/** Fixture DOM spec: tag, optional text/href/class/attrs, children. */
interface DomSpec {
  tag: string;
  text?: string;
  href?: string;
  cls?: string;
  attrs?: Record<string, string>;
  children?: DomSpec[];
}

function buildElement(spec: DomSpec): FakeElement {
  const element = new FakeElement(spec.tag);
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

/** ChatGPT-shaped message: [data-turn-id] div > content div > blocks + copy action. */
function buildDocument(identity: string, dom: DomSpec | undefined): FakeDocument {
  const message = new FakeElement("div", { "data-turn-id": identity });
  if (dom) message.childrenNodes.push(buildElement(dom));
  return new FakeDocument([message]);
}

/** Message content wrapper: blocks plus the copy action button (excluded chrome). */
const contentSpec = (blocks: DomSpec[]): DomSpec => ({
  tag: "div",
  children: [...blocks, { tag: "button", attrs: { "data-testid": "copy-turn-action-button" } }]
});

/** Execute a CDP Runtime.evaluate expression against the fake DOM. */
function runExpression(expression: string, document: FakeDocument): unknown {
  const fn = new Function("document", "Node", `"use strict"; return (${expression});`);
  return fn(document, FAKE_NODE);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CODE = 'const replySmoke = "ok";';
/** Streamed shape: inline `<code>` inside a paragraph, no language class. */
const inlineDom: DomSpec = contentSpec([{ tag: "p", children: [{ tag: "code", text: CODE }] }]);
/** Final shape: fenced `<pre><code>` with identical text and still no language class. */
const fencedDom: DomSpec = contentSpec([{ tag: "pre", children: [{ tag: "code", text: CODE }] }]);

function staticDomClient(dom: DomSpec | undefined): CdpClient {
  const document = dom ? buildDocument("r1", dom) : new FakeDocument([]);
  return {
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => ({ result: { value: runExpression(expression, document) } })
    }
  } as never;
}

// ---------------------------------------------------------------------------
// 1. Probe/capture revision identity and the nested same-text blind spot
// ---------------------------------------------------------------------------

test("probe and capture compute identical revisions on the same DOM", async () => {
  for (const dom of [inlineDom, fencedDom]) {
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
