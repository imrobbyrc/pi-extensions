import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodemodeStore,
  validateCodemodeStoreState,
} from "../src/mcp/codemode-store.js";
import {
  assertSafeMcpExposure,
  bearerTokenFromHeader,
  bearerTokenMatches,
  isLoopbackHost,
} from "../src/mcp/request-auth.js";

test("codemode store commits atomically and rejects invalid batches without changing prior state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-openai-web-store-"));
  const store = new CodemodeStore(dir);
  await store.commit("session-a", {}, { set: { answer: 42 }, delete: [] });
  await assert.rejects(
    store.commit("session-a", { answer: 42 }, { set: { bad_key: undefined }, delete: [] }),
    /codemode_store_invalid/,
  );
  assert.deepEqual(await store.load("session-a"), { answer: 42 });
  assert.notEqual(await readFile(join(dir, "session-a.json"), "utf8"), "");
});

test("codemode store merges concurrent writes for one authoritative identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-openai-web-store-"));
  const store = new CodemodeStore(dir);
  await Promise.all([
    store.commit("session-a", {}, { set: { first: 1 }, delete: [] }),
    store.commit("session-a", {}, { set: { second: 2 }, delete: [] }),
  ]);
  assert.deepEqual(await store.load("session-a"), { first: 1, second: 2 });
});

test("codemode store validation bounds keys and values", () => {
  assert.throws(() => validateCodemodeStoreState({ "bad key": 1 }), /codemode_store_invalid/);
  assert.throws(() => validateCodemodeStoreState({ huge: "x".repeat(9_000) }), /codemode_store_invalid/);
});

test("MCP exposure fails closed off-loopback and preserves loopback tunnel compatibility", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.999.0.1"), false);
  assert.doesNotThrow(() => assertSafeMcpExposure({ mcpHost: "127.0.0.1" }));
  assert.throws(() => assertSafeMcpExposure({ mcpHost: "0.0.0.0" }), /mcp_exposure_unsafe/);
  assert.doesNotThrow(() => assertSafeMcpExposure({ mcpHost: "0.0.0.0", mcpAuthToken: "strong-token" }));
});

test("bearer auth parsing and comparison are exact and fail closed", () => {
  assert.equal(bearerTokenFromHeader("Bearer abc"), "abc");
  assert.equal(bearerTokenFromHeader("Basic abc"), undefined);
  assert.equal(bearerTokenMatches("abc", "abc"), true);
  assert.equal(bearerTokenMatches("abc", "abcd"), false);
  assert.equal(bearerTokenMatches(undefined, "abc"), false);
});
