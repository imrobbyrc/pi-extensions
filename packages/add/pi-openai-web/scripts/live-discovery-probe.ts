/** Live probe: run real model catalog discovery against the configured Browser/CDP. */
import { loadConfig } from "../src/config.js";
import { discoverModelCatalog } from "../src/provider/discovery.js";

const config = await loadConfig();
console.log(`CDP: ${config.cdpHost}:${config.cdpPort}`);
try {
  const models = await discoverModelCatalog(config, (m) => console.log(`[probe] ${m}`));
  console.log(JSON.stringify(models, null, 2));
  console.log(`discovered ${models.length} models`);
} catch (error) {
  console.error(`DISCOVERY FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
