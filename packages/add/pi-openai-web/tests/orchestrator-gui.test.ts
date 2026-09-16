import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createOrchestratorSettingsComponent,
  SelectSubmenuComponent
} from "../src/provider/orchestrator-gui.js";
import {
  DEFAULT_ORCHESTRATOR_CONFIG,
  type OrchestratorConfig,
  type OrchestratorScope,
  type OrchestratorState
} from "../src/provider/orchestrator.js";

describe("Lead Architect GUI Component", () => {
  const mockState: OrchestratorState = {
    config: { ...DEFAULT_ORCHESTRATOR_CONFIG },
    scope: "project"
  };

  it("renders main settings list with header and setting items", () => {
    const component = createOrchestratorSettingsComponent({
      current: mockState,
      availableModels: ["openai-web/gpt-5.6-instant", "custom/model-x"],
      onSave: async () => {},
      onDone: () => {}
    });

    const rendered = component.render(80);
    assert.ok(rendered.length > 5, "Component rendered lines");
    const fullText = rendered.join("\n");
    assert.ok(fullText.includes("OpenAI Web Lead Architect Orchestrator"), "Includes title");
    assert.ok(!fullText.includes("Orchestrator Mode"), "Lead mode is unconditional; no toggle");
    assert.ok(fullText.includes("Worker Model"), "Includes Worker Model setting");
    assert.ok(fullText.includes("Thinking Level"), "Includes Thinking Level setting");
    assert.ok(fullText.includes("Max Workers"), "Includes Max Workers setting");
    assert.ok(fullText.includes("Delegation Strategy"), "Includes Delegation Strategy");
    assert.ok(fullText.includes("Save Scope"), "Includes Scope setting");
  });

  it("opens submenu for Worker Model and selects a new model", () => {
    let savedConfig: OrchestratorConfig | undefined;
    let savedScope: OrchestratorScope | undefined;
    let doneCalled = false;

    const component = createOrchestratorSettingsComponent({
      current: mockState,
      availableModels: ["custom/my-fast-worker"],
      onSave: async (cfg, scp) => {
        savedConfig = cfg;
        savedScope = scp;
      },
      onDone: (saved) => {
        doneCalled = saved;
      }
    });

    // Worker Model is item 0 (initial selection); Enter opens the submenu.
    component.handleInput("\r");

    const submenuRendered = component.render(80).join("\n");
    assert.ok(submenuRendered.includes("[Submenu] Worker Model"), "Submenu opened");
    assert.ok(submenuRendered.includes("zai/glm-5.3"), "Lists worker models");

    // Select the next model in submenu
    component.handleInput("\u001b[B"); // Down arrow in submenu
    component.handleInput("\r"); // Confirm selection

    // Submenu should now be closed and Worker Model updated
    const afterRender = component.render(80).join("\n");
    assert.ok(afterRender.includes("openai-codex/gpt-5.6-luna"), "Updated to selected model");
    void savedConfig; void savedScope; void doneCalled;
  });

  it("cycles thinking levels on Space", () => {
    const component = createOrchestratorSettingsComponent({
      current: mockState,
      availableModels: [],
      onSave: async () => {},
      onDone: () => {}
    });

    // Move to Thinking Level (item 1)
    component.handleInput("\u001b[B");
    let rendered = component.render(80).join("\n");
    assert.ok(rendered.includes("high"), "Initially high");

    component.handleInput(" ");
    rendered = component.render(80).join("\n");
    assert.ok(rendered.includes("max"), "Cycled to max");

    component.handleInput(" ");
    rendered = component.render(80).join("\n");
    assert.ok(rendered.includes("medium"), "Cycled to medium");
  });

  it("triggers onSave and onDone when Save & Apply is activated", async () => {
    let savedConfig: OrchestratorConfig | undefined;
    let savedScope: OrchestratorScope | undefined;
    let doneStatus: boolean | undefined;

    const component = createOrchestratorSettingsComponent({
      current: mockState,
      availableModels: [],
      onSave: async (cfg, scp) => {
        savedConfig = cfg;
        savedScope = scp;
      },
      onDone: (status) => {
        doneStatus = status;
      }
    });

    // Navigate down to 'Save & Apply' (item 5)
    for (let i = 0; i < 5; i++) {
      component.handleInput("\u001b[B");
    }

    // Press Enter on Save
    component.handleInput("\r");

    // Allow async onSave to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(savedConfig, "Config was saved");
    assert.equal(savedConfig?.workerModel, mockState.config.workerModel, "Worker model preserved");
    assert.equal(savedScope, "project", "Scope matches");
    assert.equal(doneStatus, true, "onDone called with true");
  });
});
