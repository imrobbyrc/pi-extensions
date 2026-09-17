import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { resolveInsideWorkspace } from "./path-safety.js";

const execFileAsync = promisify(execFile);
const SKIP = new Set([".git", "node_modules", ".venv", "venv", "dist", "build", ".next", "coverage"]);

export async function searchWorkspace(
  root: string,
  query: string,
  maxResults = 50,
  glob?: string
): Promise<string> {
  const rootReal = await resolveInsideWorkspace(root, ".");
  try {
    const args = [
      "--line-number",
      "--column",
      "--no-heading",
      "--color=never",
      "--hidden",
      "--glob=!**/.git/**",
      "--glob=!**/node_modules/**",
      "--glob=!**/.venv/**",
      "--glob=!**/dist/**",
      "--glob=!**/build/**"
    ];
    if (glob) args.push("--glob", glob);
    args.push("--", query, ".");
    const result = await execFileAsync("rg", args, {
      cwd: rootReal,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024
    });
    return result.stdout.split(/\r?\n/).filter(Boolean).slice(0, maxResults).join("\n");
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    const stdout = (error as { stdout?: string }).stdout;
    if (typeof stdout === "string" && stdout.length > 0) {
      return stdout.split(/\r?\n/).filter(Boolean).slice(0, maxResults).join("\n");
    }
    if (code !== "ENOENT" && code !== 1) {
      throw error;
    }
    return fallbackSearch(rootReal, query, maxResults, glob);
  }
}

/**
 * Compile a ripgrep-style glob into a matcher for the rg-free fallback walk.
 * Supports the gitignore subset ripgrep users rely on: '*' any characters
 * except '/', '**' any characters (a leading '**' followed by a slash matches
 * any depth including root), '?' one character except '/', and a leading '!'
 * negation. Patterns without '/' match the file name at any depth; patterns
 * with '/' anchor to the workspace root. Anything outside this subset throws
 * so the search fails closed instead of silently widening scope.
 */
function compileGlob(glob: string): (relativePath: string) => boolean {
  const negated = glob.startsWith("!");
  const pattern = glob.slice(negated ? 1 : 0);
  if (pattern.length === 0 || /[\[\]{}]/.test(pattern)) {
    throw new Error(`search_workspace glob "${glob}" cannot be enforced without ripgrep; refusing to widen search scope`);
  }
  const escape = (char: string): string => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      let stars = 1;
      while (pattern[index + stars] === "*") stars += 1;
      const after = pattern[index + stars];
      const segmentStart = index === 0 || pattern[index - 1] === "/";
      const wholeSegment = stars >= 2 && segmentStart && (after === undefined || after === "/");
      if (wholeSegment && after === "/") {
        source += "(?:.*/)?";
        index += stars; // also consume the following slash
      } else if (wholeSegment) {
        source += ".*";
        index += stars - 1;
      } else {
        // Single '*' and '**' inside a segment never cross '/'.
        source += "[^/]*";
        index += stars - 1;
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escape(char);
    }
  }
  const anchored = pattern.includes("/");
  const regex = new RegExp(`^${source}$`);
  return (relativePath) => {
    const candidate = anchored ? relativePath : (relativePath.split("/").pop() ?? relativePath);
    return regex.test(candidate) !== negated;
  };
}

async function fallbackSearch(root: string, query: string, maxResults: number, glob?: string): Promise<string> {
  const results: string[] = [];
  const needle = query.toLowerCase();
  const globMatches = glob ? compileGlob(glob) : undefined;

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxResults) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (entry.isDirectory() && (SKIP.has(entry.name) || entry.name.startsWith("."))) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      try {
        const relativePath = relative(root, full).split("\\").join("/");
        if (globMatches && !globMatches(relativePath)) continue;
        const raw = await readFile(full);
        if (raw.length > 512_000 || raw.includes(0)) continue;
        const lines = raw.toString("utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length && results.length < maxResults; i += 1) {
          const line = lines[i] ?? "";
          if (line.toLowerCase().includes(needle)) {
            results.push(`${relative(root, full)}:${i + 1}: ${line}`);
          }
        }
      } catch {
        // Ignore unreadable files in the fallback search.
      }
    }
  }

  await walk(root);
  return results.join("\n");
}
