import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchWorkspace } from "../src/workspace/search.js";

/**
 * When ripgrep is unavailable, searchWorkspace falls back to a JS walker. That
 * fallback must honor the requested glob exactly: dropping it silently widens
 * the search scope beyond what the caller asked for. Ripgrep-unavailability is
 * simulated by pointing PATH at an empty directory so execFile("rg") fails with
 * ENOENT — the same condition production hits when rg is not installed.
 */
async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-search-glob-"));
  await writeFile(join(dir, "notes.md"), "needle here\n");
  await writeFile(join(dir, "code.ts"), "needle there\n");
  await mkdir(join(dir, "docs"));
  await writeFile(join(dir, "docs", "deep.md"), "needle deep\n");
  return dir;
}

async function withRipgrepUnavailable<T>(run: () => Promise<T>): Promise<T> {
  const emptyPath = await mkdtemp(join(tmpdir(), "pi-empty-path-"));
  const originalPath = process.env.PATH;
  process.env.PATH = emptyPath;
  try {
    return await run();
  } finally {
    process.env.PATH = originalPath;
    await rm(emptyPath, { recursive: true, force: true });
  }
}

test("fallback search enforces the requested glob when ripgrep is unavailable", async () => {
  const dir = await makeWorkspace();
  try {
    await withRipgrepUnavailable(async () => {
      const markdownOnly = await searchWorkspace(dir, "needle", 50, "*.md");
      assert.match(markdownOnly, /notes\.md/);
      assert.match(markdownOnly, /deep\.md/, "basename globs match at any depth, like ripgrep");
      assert.doesNotMatch(markdownOnly, /code\.ts/, "glob '*.md' must exclude non-matching files");

      const excluded = await searchWorkspace(dir, "needle", 50, "!*.md");
      assert.match(excluded, /code\.ts/);
      assert.doesNotMatch(excluded, /notes\.md/, "negated glob must exclude matching files");
      assert.doesNotMatch(excluded, /deep\.md/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fallback search fails closed on globs it cannot faithfully enforce", async () => {
  const dir = await makeWorkspace();
  try {
    await withRipgrepUnavailable(async () => {
      // Brace expansion is outside the enforceable subset: refuse rather than
      // return results wider than the requested scope.
      await assert.rejects(() => searchWorkspace(dir, "needle", 50, "*.{md,ts}"), /glob/i);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fallback search preserves ripgrep case sensitivity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-search-case-"));
  try {
    await writeFile(join(dir, "case.txt"), "Needle only\n");
    await withRipgrepUnavailable(async () => {
      const result = await searchWorkspace(dir, "needle", 50, "*.txt");
      assert.doesNotMatch(result, /case\.txt/, "fallback must match rg's case-sensitive default");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("glob still filters through ripgrep when it is available", async () => {
  const dir = await makeWorkspace();
  try {
    const rgAvailable = await new Promise<boolean>((resolve) => {
      import("node:child_process").then(({ execFile }) => {
        execFile("rg", ["--version"], (error: unknown) => resolve(error === null));
      });
    });
    if (!rgAvailable) return; // environment without rg: covered by the fallback tests above
    const markdownOnly = await searchWorkspace(dir, "needle", 50, "*.md");
    assert.match(markdownOnly, /notes\.md/);
    assert.doesNotMatch(markdownOnly, /code\.ts/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
