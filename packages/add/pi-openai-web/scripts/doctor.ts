import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.js";

const execFileAsync = promisify(execFile);
const config = await loadConfig();
let failed = false;

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failed = true;
    console.error(`✗ ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

await check("Node >= 20", async () => {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) throw new Error(`found ${process.versions.node}`);
  return process.versions.node;
});

await check("git", async () => (await execFileAsync("git", ["--version"], { encoding: "utf8" })).stdout.trim());
await check("Pi CLI", async () => (await execFileAsync("pi", ["--version"], { encoding: "utf8" })).stdout.trim());
await check(`Browser/CDP (${config.browser})`, async () => {
  const response = await fetch(`http://${config.cdpHost}:${config.cdpPort}/json/version`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { Browser?: string };
  return body.Browser ?? "reachable";
});

console.log(`\nLocal MCP target: http://${config.mcpHost}:${config.mcpPort}${config.mcpPath}`);
console.log(`Configured public MCP: ${config.publicMcpUrl ?? "(none)"}`);
console.log(`ChatGPT app name: ${config.chatgptAppName}`);

if (failed) process.exitCode = 1;
