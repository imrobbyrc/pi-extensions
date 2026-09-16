import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CATALOG_SCHEMA_VERSION,
  OpenAIWebModelCatalog,
  toDescriptors,
  UnknownCatalogVersionError,
  diffDescriptorIds
} from "../src/provider/catalog.js";
import { descriptorId, normalizeToBaseId, collisionSuffix } from "../src/provider/model-ids.js";
import type { DiscoveredModel } from "../src/provider/types.js";

function liveCatalog(): DiscoveredModel[] {
  return [
    { browserModelLabel: "GPT-5.6 Sol", displayName: "GPT-5.6 Sol", efforts: ["Low", "Medium", "High"] },
    { browserModelLabel: "Claude Sonnet 4.6 (Thinking)", displayName: "Claude Sonnet 4.6 (Thinking)", efforts: null },
    { browserModelLabel: "GPT-5.6 Sol", displayName: "GPT-5.6 Sol", efforts: ["Low", "Medium", "High"] } // duplicate row must dedupe by id, not explode
  ];
}

function makeCatalog(discovered: DiscoveredModel[] = liveCatalog(), cachePath?: string, limits = { successTtlMs: 1000, failureRetryMs: 50 }): OpenAIWebModelCatalog {
  return new OpenAIWebModelCatalog({
    cachePath: cachePath ?? join(tmpdir(), `catalog-test-${Math.random().toString(36).slice(2)}.json`),
    limits,
    discover: async () => discovered
  });
}

test("normalizeToBaseId produces lowercase kebab slugs", () => {
  assert.equal(normalizeToBaseId("GPT-5.6 Sol"), "gpt-5-6-sol");
  assert.equal(normalizeToBaseId("Claude Sonnet 4.6 (Thinking)"), "claude-sonnet-4-6-thinking");
  assert.equal(normalizeToBaseId("  O3  Pro "), "o3-pro");
  assert.equal(normalizeToBaseId("!!!"), "model");
});

test("descriptorId is deterministic with effort suffix and stable collision suffix", () => {
  const taken = new Set<string>();
  const first = descriptorId("GPT-5.6 Sol", "High", taken);
  taken.add(first);
  assert.equal(first, "gpt-5-6-sol-high");
  // Same base id, no effort -> base only
  assert.equal(descriptorId("GPT-5.6 Sol", null, taken), "gpt-5-6-sol");
  // Collision produces deterministic hash suffix, stable across runs
  const suffixA = descriptorId("GPT-5.6 Sol", "High", new Set(["gpt-5-6-sol-high"]));
  const suffixB = descriptorId("GPT-5.6 Sol", "High", new Set(["gpt-5-6-sol-high"]));
  assert.equal(suffixA, suffixB);
  assert.equal(suffixA, `gpt-5-6-sol-high-${collisionSuffix("GPT-5.6 Sol", "High")}`);
});

test("toDescriptors enumerates every effort combination with unique ids", () => {
  const descriptors = toDescriptors(liveCatalog(), "live", "2026-01-01T00:00:00.000Z");
  const ids = descriptors.map(d => d.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("gpt-5-6-sol-high"));
  const claude = descriptors.find(d => d.displayName.startsWith("Claude"));
  assert.ok(claude);
  assert.equal(claude.effort, null); // no effort selector -> base id only
  assert.ok(!ids.some(id => id.startsWith("claude-sonnet") && id.endsWith("-high")));
});

test("catalog refresh writes last-known-good cache and reports diffs", async () => {
  const cachePath = join(tmpdir(), `catalog-test-${Math.random().toString(36).slice(2)}.json`);
  const catalog = makeCatalog(liveCatalog(), cachePath);
  const first = await catalog.refresh();
  assert.equal(first.ok, true);
  assert.equal(first.source, "live");
  const loaded = await makeCatalog([], cachePath).loadCache(); // fresh instance, discovery unavailable
  assert.equal(loaded.loaded, true);
  assert.ok(loaded.count >= 4);
  const second = makeCatalog(
    [...liveCatalog(), { browserModelLabel: "New Model X", displayName: "New Model X", efforts: null }],
    cachePath
  );
  // Load cache first, then refresh: added/removed are relative to cached ids.
  const cached = new OpenAIWebModelCatalog({ cachePath, limits: { successTtlMs: 0, failureRetryMs: 0 }, discover: async () => [] });
  await cached.loadCache();
  const refreshed = await second.refresh();
  assert.ok(refreshed.added.includes("new-model-x"));
  assert.ok(refreshed.removed.length >= 0);
});

test("failed discovery keeps last-known-good catalog and reports error", async () => {
  const cachePath = join(tmpdir(), `catalog-test-${Math.random().toString(36).slice(2)}.json`);
  const good = makeCatalog(liveCatalog(), cachePath);
  await good.refresh();
  const broken = new OpenAIWebModelCatalog({
    cachePath,
    limits: { successTtlMs: 0, failureRetryMs: 0 },
    discover: async () => { throw new Error("browser unreachable"); }
  });
  await broken.loadCache();
  const result = await broken.refresh();
  assert.equal(result.ok, false);
  assert.equal(result.models.length, good.models.length); // preserved
  assert.match(broken.lastError ?? "", /browser unreachable/);
});

test("empty discovery fails without erasing cache", async () => {
  const cachePath = join(tmpdir(), `catalog-test-${Math.random().toString(36).slice(2)}.json`);
  const good = makeCatalog(liveCatalog(), cachePath);
  await good.refresh();
  const empty = new OpenAIWebModelCatalog({ cachePath, limits: { successTtlMs: 0, failureRetryMs: 0 }, discover: async () => [] });
  await empty.loadCache();
  const result = await empty.refresh();
  assert.equal(result.ok, false);
  assert.equal(result.models.length, good.models.length);
});

test("unknown cache schema version fails actionably", async () => {
  const cachePath = join(tmpdir(), `catalog-test-${Math.random().toString(36).slice(2)}.json`);
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(join(cachePath, ".."), { recursive: true });
  await writeFile(cachePath, JSON.stringify({ schemaVersion: 9999, discoveredAt: "x", models: [] }), "utf8");
  await assert.rejects(
    () => makeCatalog(liveCatalog(), cachePath).loadCache(),
    (error: unknown) => error instanceof UnknownCatalogVersionError && /Delete .* and run \/openai-web models refresh/.test(error.message)
  );
});

test("shouldRefresh honors success TTL then failure retry TTL", async () => {
  const cachePath = join(tmpdir(), `catalog-test-${Math.random().toString(36).slice(2)}.json`);
  const catalog = new OpenAIWebModelCatalog({
    cachePath,
    limits: { successTtlMs: 1000, failureRetryMs: 10 },
    discover: async () => liveCatalog()
  });
  await catalog.loadCache();
  assert.equal(catalog.shouldRefresh(), true); // empty catalog always refreshes
  await catalog.refresh();
  assert.equal(catalog.shouldRefresh(), false); // fresh within TTL
  const stale = new OpenAIWebModelCatalog({
    cachePath,
    limits: { successTtlMs: 0, failureRetryMs: 0 },
    discover: async () => { throw new Error("down"); }
  });
  await stale.loadCache();
  assert.equal(stale.shouldRefresh(), true);
});

test("diffDescriptorIds reports added/removed/changed", () => {
  const previous = toDescriptors(liveCatalog(), "cache", "t0");
  const next = toDescriptors(
    [...liveCatalog().slice(0, 1), { browserModelLabel: "Incoming", displayName: "Incoming", efforts: null }],
    "live",
    "t1"
  );
  const diff = diffDescriptorIds(previous, next);
  assert.ok(diff.added.includes("incoming"));
  assert.ok(diff.removed.length > 0);
  assert.deepEqual(diff.changed, []);
});

test("cache stores only safe metadata with schema version", async () => {
  const cachePath = join(tmpdir(), `catalog-test-${Math.random().toString(36).slice(2)}.json`);
  const catalog = makeCatalog(liveCatalog(), cachePath);
  await catalog.refresh();
  const raw = JSON.parse(await (await import("node:fs/promises")).readFile(cachePath, "utf8"));
  assert.equal(raw.schemaVersion, CATALOG_SCHEMA_VERSION);
  assert.ok(Array.isArray(raw.models));
  for (const entry of raw.models) {
    assert.ok(typeof entry.id === "string");
    assert.ok(typeof entry.browserModelLabel === "string");
    assert.ok(!("prompt" in entry) && !("cookie" in entry) && !("transcript" in entry));
  }
});
