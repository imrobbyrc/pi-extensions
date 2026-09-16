import {
  Container,
  Text,
  Spacer,
  SettingsList,
  SelectList,
  type SettingItem,
  type SelectItem,
  type SettingsListTheme,
  type SelectListTheme,
  fuzzyFilter,
  getKeybindings,
  Input
} from "@earendil-works/pi-tui";
import type {
  DelegationStrategy,
  OrchestratorConfig,
  OrchestratorScope,
  OrchestratorState
} from "./orchestrator.js";

export interface GuiThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export function createFallbackTheme(): GuiThemeLike {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`
  };
}

export function createSettingsTheme(theme: GuiThemeLike): SettingsListTheme {
  return {
    label: (text, selected) => (selected ? theme.fg("accent", text) : text),
    value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
    description: (text) => theme.fg("dim", text),
    cursor: theme.fg("accent", "→ "),
    hint: (text) => theme.fg("dim", text)
  };
}

export function createSelectTheme(theme: GuiThemeLike): SelectListTheme {
  return {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("dim", text)
  };
}

/**
 * Submenu component for selecting from a list of options (e.g. worker models).
 * Supports fuzzy search filtering, arrow key navigation, Enter to select, and Esc to go back.
 */
export class SelectSubmenuComponent extends Container {
  private selectList: SelectList;
  private searchInput?: Input;
  private allOptions: SelectItem[];
  private onSelectCb: (value: string) => void;
  private onCancelCb: () => void;
  private listChildIndex: number;
  private theme: GuiThemeLike;

  constructor(
    title: string,
    description: string,
    options: SelectItem[],
    currentValue: string,
    theme: GuiThemeLike,
    onSelect: (value: string) => void,
    onCancel: () => void,
    searchable = true
  ) {
    super();
    this.theme = theme;
    this.allOptions = options;
    this.onSelectCb = onSelect;
    this.onCancelCb = onCancel;

    this.addChild(new Text(theme.bold(theme.fg("accent", `[Submenu] ${title}`)), 0, 0));
    if (description) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(theme.fg("muted", description), 0, 0));
    }

    if (searchable) {
      this.addChild(new Spacer(1));
      this.searchInput = new Input();
      this.searchInput.onSubmit = () => {
        this.selectList.handleInput("\r");
      };
      this.addChild(this.searchInput);
    }

    this.addChild(new Spacer(1));
    const selectTheme = createSelectTheme(theme);
    this.selectList = this.buildSelectList(options, currentValue, selectTheme);
    this.listChildIndex = this.children.length;
    this.addChild(this.selectList);

    this.addChild(new Spacer(1));
    const hint = searchable
      ? "  Type to filter · ↑/↓ to navigate · Enter to select · Esc to back"
      : "  ↑/↓ to navigate · Enter to select · Esc to back";
    this.addChild(new Text(theme.fg("dim", hint), 0, 0));
  }

  private buildSelectList(options: SelectItem[], preselect: string, selectTheme: SelectListTheme): SelectList {
    const list = new SelectList(options, Math.min(options.length, 10), selectTheme);
    const idx = options.findIndex((o) => o.value === preselect);
    if (idx !== -1) {
      list.setSelectedIndex(idx);
    }
    list.onSelect = (item) => this.onSelectCb(item.value);
    list.onCancel = this.onCancelCb;
    return list;
  }

  private applyFilter(query: string): void {
    const filtered = query
      ? fuzzyFilter(this.allOptions, query, (item) => `${item.label} ${item.description ?? ""}`)
      : this.allOptions;
    const selectTheme = createSelectTheme(this.theme);
    const newList = this.buildSelectList(filtered, "", selectTheme);
    this.children[this.listChildIndex] = newList;
    this.selectList = newList;
  }

  handleInput(data: string): void {
    if (this.searchInput) {
      const kb = getKeybindings();
      const isNav =
        kb.matches(data, "tui.select.up") ||
        kb.matches(data, "tui.select.down") ||
        kb.matches(data, "tui.select.confirm") ||
        kb.matches(data, "tui.select.cancel");
      if (isNav) {
        this.selectList.handleInput(data);
      } else {
        this.searchInput.handleInput(data);
        this.applyFilter(this.searchInput.getValue());
      }
    } else {
      this.selectList.handleInput(data);
    }
  }
}

export interface OrchestratorGuiOptions {
  current: OrchestratorState;
  availableModels: string[];
  theme?: GuiThemeLike;
  onSave: (config: OrchestratorConfig, scope: OrchestratorScope) => Promise<void>;
  onDone: (saved: boolean) => void;
}

/**
 * Creates the interactive TUI component for configuring Orchestrator settings.
 * Includes inline value cycling (dropdown toggles) and submenus (model selection).
 */
export function createOrchestratorSettingsComponent(options: OrchestratorGuiOptions): {
  render: (width: number) => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
} {
  const theme = options.theme ?? createFallbackTheme();
  let workerModel = options.current.config.workerModel;
  let workerThinking = options.current.config.workerThinking;
  let maxParallelWorkers = options.current.config.maxParallelWorkers;
  let delegationStrategy: DelegationStrategy = options.current.config.delegationStrategy;
  let scope: OrchestratorScope = options.current.scope;

  const popularModels: SelectItem[] = [
    { value: "zai/glm-5.3", label: "zai/glm-5.3", description: "Default fast orchestrator worker" },
    { value: "openai-codex/gpt-5.6-luna", label: "openai-codex/gpt-5.6-luna", description: "Codex reasoning model" },
    { value: "anthropic/claude-3-7-sonnet", label: "anthropic/claude-3-7-sonnet", description: "Hybrid reasoning model" },
    { value: "openai/gpt-5.3-codex", label: "openai/gpt-5.3-codex", description: "Codex implementation worker" }
  ];

  const externalModels = options.availableModels
    .filter((m) => !m.startsWith("openai-web/"))
    .filter((m) => !popularModels.some((p) => p.value === m))
    .map((m) => ({ value: m, label: m, description: "Discovered model" }));

  const modelOptions: SelectItem[] = [...popularModels, ...externalModels];

  const items: SettingItem[] = [
    {
      id: "workerModel",
      label: "Worker Model",
      description: "Model used for Herdr Pi worker tasks. Enter opens submenu picker.",
      currentValue: workerModel,
      submenu: (currentValue, done) =>
        new SelectSubmenuComponent(
          "Worker Model",
          "Select the model for delegated coding tasks",
          modelOptions,
          currentValue,
          theme,
          (val) => done(val),
          () => done()
        )
    },
    {
      id: "workerThinking",
      label: "Thinking Level",
      description: "Reasoning effort level for worker models.",
      currentValue: workerThinking,
      values: ["high", "max", "medium", "low", "none"]
    },
    {
      id: "maxParallelWorkers",
      label: "Max Workers",
      description: "Max parallel Herdr worker panes allowed (1 to 8).",
      currentValue: String(maxParallelWorkers),
      values: ["1", "2", "3", "4", "5", "6", "7", "8"]
    },
    {
      id: "delegationStrategy",
      label: "Delegation Strategy",
      description: "adaptive (modular tasks) vs aggressive (all code changes).",
      currentValue: delegationStrategy,
      values: ["adaptive", "aggressive"]
    },
    {
      id: "scope",
      label: "Save Scope",
      description: "project (.pi/), global (~/.pi/), or session (in-memory).",
      currentValue: scope,
      values: ["project", "global", "session"]
    },
    {
      id: "save",
      label: "Save & Apply",
      description: "Save changes to selected scope and activate orchestrator.",
      currentValue: "press Enter to save",
      values: ["save"]
    },
    {
      id: "cancel",
      label: "Cancel",
      description: "Discard changes and exit settings dialog.",
      currentValue: "press Enter to exit",
      values: ["exit"]
    }
  ];

  const container = new Container();

  // Header
  container.addChild(
    new (class {
      render(width: number) {
        const title = theme.bold(theme.fg("accent", "╭── OpenAI Web Lead Architect Orchestrator ──╮"));
        const subtitle = theme.fg("muted", "Configure worker models, concurrency, thinking, and scope.");
        const border = theme.fg("dim", "─".repeat(Math.max(1, width)));
        return [title, subtitle, border];
      }
      invalidate() {}
    })()
  );

  const settingsTheme = createSettingsTheme(theme);
  const settingsList = new SettingsList(
    items,
    Math.min(items.length + 2, 12),
    settingsTheme,
    (id, newValue) => {
      if (id === "workerModel") {
        workerModel = newValue;
      } else if (id === "workerThinking") {
        workerThinking = newValue;
      } else if (id === "maxParallelWorkers") {
        maxParallelWorkers = parseInt(newValue, 10) || 3;
      } else if (id === "delegationStrategy") {
        delegationStrategy = newValue as DelegationStrategy;
      } else if (id === "scope") {
        scope = newValue as OrchestratorScope;
      } else if (id === "save") {
        const finalConfig: OrchestratorConfig = {
          workerModel,
          workerThinking,
          maxParallelWorkers,
          delegationStrategy
        };
        void options.onSave(finalConfig, scope).then(() => {
          options.onDone(true);
        });
      } else if (id === "cancel") {
        options.onDone(false);
      }
    },
    () => {
      // Esc pressed on main list
      options.onDone(false);
    }
  );

  container.addChild(settingsList);

  return {
    render(width: number) {
      return container.render(width);
    },
    invalidate() {
      container.invalidate();
    },
    handleInput(data: string) {
      settingsList.handleInput?.(data);
    }
  };
}
