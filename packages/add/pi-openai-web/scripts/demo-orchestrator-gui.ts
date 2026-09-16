import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { createOrchestratorSettingsComponent } from "../src/provider/orchestrator-gui.js";
import {
  loadOrchestratorState,
  saveOrchestratorConfig,
  formatOrchestratorBox,
  type OrchestratorConfig,
  type OrchestratorScope
} from "../src/provider/orchestrator.js";

async function main() {
  const state = await loadOrchestratorState();
  const availableModels = [
    "openai-web/gpt-5.6-instant",
    "openai-web/gpt-5.6-medium",
    "zai/glm-5.3",
    "openai-codex/gpt-5.6-luna",
    "anthropic/claude-3-7-sonnet",
    "openai/gpt-5.3-codex"
  ];

  const terminal = new ProcessTerminal();
  const ui = new TuiMainScreen(terminal, true);

  let savedConfig: OrchestratorConfig | undefined;
  let savedScope: OrchestratorScope | undefined;

  const component = createOrchestratorSettingsComponent({
    current: state,
    availableModels,
    onSave: async (cfg, scp) => {
      savedConfig = cfg;
      savedScope = scp;
      await saveOrchestratorConfig(cfg, scp);
    },
    onDone: (saved) => {
      ui.stop();
      if (saved && savedConfig && savedScope) {
        console.log("\n" + formatOrchestratorBox({ config: savedConfig, scope: savedScope }));
        console.log("\n✅ Configuration saved successfully!");
      } else {
        console.log("\nConfiguration dialog closed without changes.");
      }
      process.exit(0);
    }
  });

  ui.addChild({
    render: (w: number) => component.render(w),
    invalidate: () => component.invalidate(),
    handleInput: (data: string) => {
      component.handleInput(data);
      ui.requestRender();
    }
  });

  ui.start();
  ui.requestRender();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
