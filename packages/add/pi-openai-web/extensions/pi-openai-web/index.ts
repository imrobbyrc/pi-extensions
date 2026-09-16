import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupProviderModule } from "./provider-module.js";
import { createSubagentController } from "@imrobbyrc/pi-core-subagent/api";
import type { SubagentController } from "@imrobbyrc/pi-core-subagent/api";

export default function chatGptPlannerExtension(pi: ExtensionAPI) {
  const subagents: SubagentController = createSubagentController(pi);
  const providerModule = setupProviderModule(pi, subagents);

  pi.on("session_shutdown", async () => {
    await providerModule.shutdown();
  });
}
