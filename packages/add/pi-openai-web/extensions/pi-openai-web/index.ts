import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupProviderModule } from "./provider-module.js";
import registerSubagentExtension from "@imrobbyrc/pi-core-subagent/src/index.ts";
import { createSubagentController } from "@imrobbyrc/pi-core-subagent/api";
import type { SubagentController } from "@imrobbyrc/pi-core-subagent/api";

export default function chatGptPlannerExtension(pi: ExtensionAPI) {
  // Temporary local copy of pi-core-subagent; replace with package API later.
  const subagents: SubagentController = createSubagentController(pi);
  registerSubagentExtension(pi, subagents.manager);
  const providerModule = setupProviderModule(pi, subagents);

  pi.on("session_shutdown", async () => {
    await providerModule.shutdown();
  });
}
