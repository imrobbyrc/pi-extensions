import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContextFile } from "../src/workspace/files.js";

const limits = { maxReadLines: 2, maxFileBytes: 10_000 };

test("readContextFile reads bounded root CONTEXT.md with line numbers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-"));
  try {
    await writeFile(join(root, "CONTEXT.md"), "domain terms\nimportant boundary\nextra detail\n");
    assert.equal(await readContextFile(root, limits), "1: domain terms\n2: important boundary");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readContextFile reports absent root context without widening access", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-"));
  try {
    assert.equal(await readContextFile(root, limits), "No CONTEXT.md found at workspace root.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
