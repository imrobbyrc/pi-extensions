# @imrobbyrc/pi-openai-web

Pi-native harness with an **always-on ChatGPT Web Lead Architect**: ChatGPT Web runs as your Pi model, reasons about architecture, inspects the workspace through a strict bounded tool allowlist, and delegates all implementation to **Herdr-managed Pi workers**. Pi stays the local execution authority. ChatGPT Web is used through a user-controlled browser session — never the OpenAI API.

## Release status

**V3 architecture, implemented and tested (90 planner tests; 159 core subagent tests).**

One product, one flow:

- **OpenAI Web Lead (always on)** — ChatGPT Web behaves like a native Pi model through `/model openai-web/<id>`, with dynamic model/effort discovery, exact browser selection, bounded context, and structured checkpoint compaction.
- **Strict lead tools** — the Lead sees exactly seven MCP tools: six bounded read-only workspace inspections plus one Pi-native `herdr` execution tool. No shell, no writes, no subagent spawning, no browser worker tabs.
- **Asynchronous native Herdr** — one `herdr` MCP tool with `run | status | correct | accept | stop` actions. `run` starts a bounded 1–4 Pi-worker execution after explicit TUI confirmation and returns immediately; workers run as Pi agents (`--kind pi`) in Herdr panes. A completed worker stays live in its pane for review: `correct` reopens it in the same pane with feedback and it completes again; `accept` finalizes it and closes the pane.

The former planner subsystem (`/planner`, task store, submit_plan/submit_review protocol, browser worker tabs, Pi subagent delegation) has been removed.

### Package boundary

`@imrobbyrc/pi-core-subagent` is the only worker-orchestration engine. This repository owns OpenAI Web, MCP, Lead policy, and composition. MCP `herdr` delegates through the package API; it must not grow a second scheduler, IPC, worktree, or Herdr runtime. No local worker engine remains in this repository; worker execution belongs to the package API.

Do not install `@imrobbyrc/pi-core-subagent` as a second Pi package while this repository is installed: both register identical native subagent tools. Planner uses package API dependency instead.

## What it does

Select a discovered ChatGPT Web model/effort as your active Pi model:

```text
/model openai-web/gpt-5-6-sol-medium
```

ChatGPT Web streams responses natively into Pi. The Lead Architect contract is injected into every provider turn: the Lead reasons, decomposes work, and — only after its mandatory planning gate (design graph + independent critique) — submits a worker decomposition through the `herdr` tool. Pi shows you the plan, asks for explicit confirmation, then Herdr splits panes and starts Pi workers. The Lead inspects `git_status`/`git_diff` afterwards, sends bounded `correct` rounds to the worker's own pane until the work is good, `accept`s each approved worker to close its pane, and reports the result.

```text
Lead turn → herdr run (1–4 workers, DAG, ownership scopes)
          → explicit TUI confirmation in Pi
          → Herdr panes, Pi workers (kind=pi)
          → herdr status / correct (same pane, repeatable) / accept (finalize)
          → Lead reviews diff → result
```

## Start here

### Prerequisites

- macOS first; Linux partially supported; Windows launcher not supported
- Node.js 20+, Pi, Git
- Herdr CLI installed with a running Herdr server (workers run through the `herdr` command)
- Dia Browser (default) or optional Chrome/Chromium
- ChatGPT Web workspace supporting custom MCP apps
- `tunnel-client` account/configuration for OpenAI Secure MCP Tunnel

### One-time setup

1. Install and validate:

   ```bash
   git clone https://github.com/imrobbyrc/pi-extensions.git
   cd pi-extensions/packages/add/pi-openai-web
   npm install
   npm run typecheck
   npm test
   pi install .
   ```

   For local iteration: `pi -e ./extensions/pi-openai-web/index.ts`.

2. Launch the dedicated browser profile and log into ChatGPT (persists, so login happens once):

   ```bash
   npm run browser
   # Optional Chrome/Chromium:
   # npm run chrome
   ```

   Verify local prerequisites and browser/CDP reachability:

   ```bash
   npm run doctor
   ```

3. Store the tunnel credential in Pi:

   ```text
   /openai-web setup
   ```

   Infrastructure (browser/CDP, local MCP, tunnel) starts automatically on first use. Verify with `/openai-web doctor`.

4. Create the custom ChatGPT app named `Pi Workspace`, point it at the tunnel's remote endpoint, and scan tools. You should see `read_file`, `list_directory`, `search_workspace`, `repo_map`, `git_status`, `git_diff`, and `herdr`. See [`docs/MCP_SETUP.md`](docs/MCP_SETUP.md).

5. Verify Herdr: `herdr status server` must succeed, and `pi auth check --provider openai-codex` must pass for the default Luna Max worker profile.

### First harness task

Open a trusted project workspace in Pi, select a lead model, and ask for something real:

```text
/model openai-web/gpt-5-6-sol-high
"add a rate limiter to the API and wire up tests"
```

The Lead inspects the workspace through MCP, renders its planning graph, then submits `herdr run`. Pi asks you to confirm the goal, workers, and worker profile before any pane starts. Nothing executes without that confirmation.

## Architecture

```text
                     ChatGPT Web
           ┌───────────────────────────┐
           │  Lead Architect (always)  │
           │  ├─ exact model + effort  │
           │  ├─ bounded transcript    │
           │  └─ compaction epoch      │
           └────────────┬──────────────┘
                        │
                  browser / CDP
                   CONTROL PLANE
                        │
                        ▼
   strict MCP data plane (7 tools, via tunnel)
                        │
                        ▼
                 Pi Host / Harness
                        │
                  herdr run (confirmed)
                        │
              ┌─────────┼─────────┐
              │   Herdr panes     │
              │  Pi workers (1–4) │
              └─────────┬─────────┘
                        ▼
                local workspace
```

### Control plane

Pi controls a user-authorized Dia (default on macOS) or Chrome browser over CDP. The browser controller opens/focuses ChatGPT Web, selects the exact model and reasoning effort, attaches the `Pi Workspace` app, and sends small prompts. It does not scrape ChatGPT responses as a data channel.

### Data plane

```text
ChatGPT Web → Pi Workspace app → OpenAI Secure MCP Tunnel → local MCP (:8765/mcp) → workspace
```

Strict frozen allowlist — the only tools the Lead can see:

| Tool | Kind | Purpose |
| --- | --- | --- |
| `read_file` | read-only | Bounded line range from a workspace text file |
| `list_directory` | read-only | One directory listing |
| `search_workspace` | read-only | Bounded text search (ripgrep or safe JS fallback) |
| `repo_map` | read-only | Bounded directory tree |
| `git_status` | read-only | Git status |
| `git_diff` | read-only | Git diff (staged or unstaged) |
| `herdr` | **mutating** | `run \| status \| correct \| accept \| stop` — Pi-native worker execution |

The `herdr` tool is honestly annotated (`readOnlyHint: false`, `destructiveHint: true`). Everything else is read-only. There are no shell, edit, write, install, migration, git-mutation, or subagent tools at any endpoint.

### Authority

| Capability | ChatGPT Web (Lead) | Pi | Herdr Pi workers |
| --- | --- | --- | --- |
| Architecture / decomposition / review | yes | records results | no |
| Read/search workspace | via MCP only | yes | local execution |
| Edit source / run tests | never | yes (native permission flow) | inside approved `owns` scopes |
| Git commit/push/deploy | never | never automatic | prohibited |
| Spawn panes / delegate / switch models | never | n/a | prohibited |

## Herdr execution

### Contract

The Lead submits a bounded decomposition; Pi validates it fail-closed:

```json
{
  "action": "run",
  "goal": "add rate limiting with tests",
  "workers": [
    { "id": "worker-core", "objective": "implement limiter", "owns": ["src/limiter/**"], "depends_on": [] },
    { "id": "worker-tests", "objective": "add test coverage", "owns": ["test/**"], "depends_on": ["worker-core"] }
  ]
}
```

- 1–4 workers; cycles, overlapping/empty scopes, and `openai-web` worker models are rejected.
- Workers always run as Pi agents (`herdr agent start --kind pi`); the default profile is Luna Max (`openai-codex/gpt-5.6-luna`, thinking `max`), configurable via `/openai-web orches`.
- Dependency-free workers with proven non-overlapping scopes run in parallel in one shared working tree.
- Workers cannot spawn panes, delegate, switch models, commit, push, deploy, or expand scope. Unowned or ambiguous source mutations fail closed against the run baseline.

### Confirmation gate

`run` requires explicit confirmation in Pi's TUI (goal, workers, worker profile). Headless sessions fail closed unless `harnessAutoApproveHerdrRun` is explicitly set — and a human "no" in the TUI is final even then.

### Lifecycle

- `run` returns the run handle immediately; execution continues in the background.
- `status` reads the persisted run lifecycle (workers, panes, baselines, failures, correction rounds). A completed herdr worker stays live in its pane awaiting review — it is never auto-cleaned while reviewable.
- `correct` sends bounded review feedback to one exact worker: a completed worker reopens in its SAME pane and session (same agent, accumulated context) and completes again for re-review — repeatable, the round count shows in `status`; a still-running worker is steered mid-flight. The worker is always reused, never replaced.
- `accept` accepts one completed worker's work: marks it accepted and closes its pane (idempotent). This is the required finalization for every approved worker.
- `stop` stops a run and closes its owned panes, including unaccepted completed workers (omit `run_id` to reap all owned panes).

## Provider features

- **Dynamic model discovery & exact selection** — the catalog is discovered from the logged-in account via visible picker controls only; deterministic ids (`gpt-5-6-sol-high`, …); versioned last-known-good cache under `<stateDir>/provider/model-catalog.json`; failed discovery never erases the cache; optional `browser-extension/` page-marker assist with CDP fallback.
- **Token estimation & separate ceilings** — `tiktoken` (`o200k_base`), bounded chunks with UTF-8 boundary guard; separate `providerContextLimitTokens` and `providerComposerLimitTokens`.
- **Structured compaction** — `/openai-web compact` and the automatic threshold request a handoff brief; only machine-readable `[PI-COMPACTION-CHECKPOINT]` JSON envelopes are accepted; fallback rebuilds from canonical Pi history.
- **Durable transcripts & resume** — bounded JSONL session records under `<stateDir>/provider/sessions`; provider resume metadata persisted and validated.

## Commands

| Command | Purpose |
| --- | --- |
| `/model openai-web/<id>` | Select a discovered ChatGPT Web model/effort (Lead is always on) |
| `/openai-web setup` | Store the Secure MCP Tunnel credential (`setup reset` clears it) |
| `/openai-web start` | Start browser/CDP, local MCP, and the tunnel |
| `/openai-web models [refresh]` | Show (or re-discover) the model catalog |
| `/openai-web reset` | Reset the provider conversation (next turn opens a fresh Temporary Chat) |
| `/openai-web compact` | Compact the conversation via validated checkpoint |
| `/openai-web orches` / `/openai-web config` / `/openai-web ui` | Lead/worker profile TUI: worker model, thinking, max parallel workers (1–8), strategy, scope |
| `/openai-web orches <cmd>` | Non-interactive: `status`, `model <id>`, `thinking <level>`, `workers <1-8>`, `strategy <adaptive\|aggressive>`, `scope <project\|global\|session>` |
| `/openai-web doctor` | Diagnostics: catalog, infrastructure, credential, lead profile, Herdr, recent runs |

## Setup and configuration

### Local MCP and tunnel

The harness starts local MCP lazily at:

```text
http://127.0.0.1:8765/mcp
```

Health endpoint: `http://127.0.0.1:8765/healthz`.

ChatGPT cannot reach localhost directly. Use the configured `tunnel-client` and OpenAI Secure MCP Tunnel. Create the custom ChatGPT app named `Pi Workspace`, point it at the tunnel's remote endpoint, and scan tools. Keep the local server loopback-bound. See [`docs/MCP_SETUP.md`](docs/MCP_SETUP.md).

### Configuration precedence

Defaults < `~/.pi/chatgpt-planner/config.json` < environment variables. Copy [`config.example.json`](config.example.json) to that path.

| Variable | Default |
| --- | --- |
| `PLANNER_MCP_HOST` | `127.0.0.1` |
| `PLANNER_MCP_PORT` | `8765` |
| `PLANNER_MCP_PATH` | `/mcp` |
| `PLANNER_PUBLIC_MCP_URL` | unset |
| `PLANNER_BROWSER` | `dia` |
| `PLANNER_BROWSER_BINARY` | unset |
| `PLANNER_BROWSER_PROFILE_DIR` | `~/.pi/chatgpt-planner/<browser>-profile` |
| `PLANNER_CDP_HOST` / `PLANNER_CDP_PORT` | `127.0.0.1` / `9222` |
| `PLANNER_CHATGPT_URL` | `https://chatgpt.com/` |
| `PLANNER_CHATGPT_APP_NAME` | `Pi Workspace` |
| `PLANNER_BROWSER_AUTO_ATTACH_APP` | `true` |
| `PLANNER_VERBOSE` | `false` |
| `PLANNER_MAX_READ_LINES` | `500` |
| `PLANNER_MAX_FILE_BYTES` | `1000000` |
| `PLANNER_BROWSER_STARTUP_TIMEOUT_MS` | `20000` |
| `PLANNER_TUNNEL_*` | binary `tunnel-client`, profile `pi-planner`, health port `8080`, startup timeout `120000` |
| `PLANNER_CATALOG_SUCCESS_TTL_MS` / `PLANNER_CATALOG_FAILURE_RETRY_MS` | `86400000` / `180000` |
| `PLANNER_PROVIDER_TURN_TIMEOUT_MS` / `PLANNER_PROVIDER_STALL_TIMEOUT_MS` / `PLANNER_PROVIDER_TOOL_WAIT_MS` | `600000` / `90000` / `300000` |
| `PLANNER_PROVIDER_COMPACTION_*`, `PLANNER_PROVIDER_CONTEXT/COMPOSER_LIMIT_TOKENS`, `PLANNER_PROVIDER_SESSION_RETENTION_DAYS` | see `config.example.json` |
| `HARNESS_AUTO_APPROVE_HERDR_RUN` | `false` (headless `herdr run` fails closed) |

## Troubleshooting: symptom → action

| Symptom | Action |
| --- | --- |
| Infrastructure not ready | `/openai-web doctor`; `npm run doctor` for Node, Git, Pi, CDP. |
| Authentication missing | `/openai-web setup`, then retry. |
| Browser/CDP unreachable or logged out | Keep the dedicated profile running, log into ChatGPT, rerun `npm run browser` or `npm run chrome`. |
| Herdr unavailable | Check `herdr status server`; workers also need `pi auth check --provider openai-codex`. |
| `herdr run` rejected headless | Set `HARNESS_AUTO_APPROVE_HERDR_RUN=true` explicitly, or run with a TUI so confirmation can be asked. |
| Catalog stale | `/openai-web models refresh` with the browser running. |

## State, security, and recovery

State persists outside the repository by default:

```text
~/.pi/chatgpt-planner/
├── config.json
├── .env
├── dia-profile/
├── provider/
│   ├── model-catalog.json
│   ├── resume.json
│   └── sessions/
└── provider/
    └── sessions/
```

Read [`SECURITY.md`](SECURITY.md) before exposing MCP. Key boundaries:

- local MCP binds to `127.0.0.1` by default;
- the Lead's only mutating tool is `herdr`, honestly annotated and gated on explicit confirmation;
- no shell, write, package, migration, git-mutation, commit, push, deploy, or subagent tools exist at any endpoint;
- real-path checks prevent escaping the workspace; reads are bounded;
- credentials remain browser-owned; the Node process never reads browser cookies/passwords;
- worker scope and lifecycle enforcement belong to `@imrobbyrc/pi-core-subagent`; restarts never replay interrupted runs;
- shutdown reaps all Herdr panes owned by the session.

## Limitations

- ChatGPT UI settings and app-picker markup can change; manual selection may be required.
- MCP server has no OAuth/pairing; never expose the loopback endpoint directly to the public internet.
- Worker concurrency is bounded to 1–4 per run and 1–8 in the lead profile; Herdr pane management assumes a single shared machine.
- Pi extension events do not provide authoritative per-command test output; workers must surface their own evidence.

## Roadmap

Current V3 architecture is complete and validated with 90 planner tests plus 159 core subagent tests. Remaining work and future ideas are tracked in [`ROADMAP.md`](ROADMAP.md). Historical V0–V2 milestones (planner subsystem, browser worker tabs, Pi subagent delegation) are retained there as clearly labeled superseded history.
