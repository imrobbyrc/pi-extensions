import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export async function resolveInsideWorkspace(root: string, candidate: string): Promise<string> {
  if (isAbsolute(candidate)) {
    throw new Error("Absolute paths are not allowed");
  }

  const rootReal = await realpath(root);
  const resolved = resolve(rootReal, candidate || ".");
  const resolvedReal = await realpath(resolved);
  const rel = relative(rootReal, resolvedReal);

  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return resolvedReal;
  }
  throw new Error("Path escapes the workspace root");
}
