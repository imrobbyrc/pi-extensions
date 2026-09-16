import { loadConfig } from "../src/config.js";
import { launchBrowser } from "../src/browser/launcher.js";

const config = await loadConfig();

try {
  const version = await launchBrowser(config);
  console.log(`Started ${config.browser} with Browser/CDP at http://${config.cdpHost}:${config.cdpPort} — ${version}`);
  console.log(`Planner profile: ${config.browserProfileDir}`);
  console.log("Log into chatgpt.com in that window once; profile is reused on later runs.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
