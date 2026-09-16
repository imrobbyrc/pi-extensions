import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInsideWorkspace } from "../src/workspace/path-safety.js";

test("resolveInsideWorkspace permits paths inside root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-planner-path-"));
  try {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "a.ts"), "hello");
    const resolved = await resolveInsideWorkspace(dir, "src/a.ts");
    assert.match(resolved, /src\/a\.ts$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveInsideWorkspace rejects traversal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-planner-path-"));
  try {
    await assert.rejects(() => resolveInsideWorkspace(dir, "../"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
