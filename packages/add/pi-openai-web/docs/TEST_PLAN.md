# Test plan

Run everything with:

```bash
npm run typecheck
npm test
```

## Unit coverage by suite

- `@imrobbyrc/pi-core-subagent` — package API, scheduler/DAG, inprocess/Herdr runtime, IPC, worktree, ask/reply, steering, resume, and cancellation coverage (159 tests).
- `herdr.test.ts` — legacy CLI adapter/runner compatibility coverage. New worker behavior belongs in `pi-core-subagent` tests.
- `herdr-contract.test.ts` — bounded 1–4 worker DAG validation: cycles, duplicate ids, overlapping/empty scopes, `openai-web` worker models rejected.
- `orchestrator.test.ts` — lead profile persistence (project/global/session precedence), handoff envelope build/parse with graph+handoff+critique gates, always-on Lead contract (forbids subagent delegation), CLI and UI configuration flows.
- `orchestrator-gui.test.ts` — TUI settings component (submenu model picker, toggles, save/apply).
- `provider-catalog.test.ts` — deterministic model ids, cache TTLs, last-known-good cache behavior, schema versioning.
- `provider-features.test.ts` — session store, resume metadata, picker state freshness, compaction checkpoints.
- `provider-runtime-units.test.ts` — markdown extraction bounds, bootstrap context bounds, per-turn message batching, turn controller state machine.
- `provider-stream.test.ts` — provider id/model honesty, turn completion/tool-pending/failure events, unknown model ids fail explicitly.
- `provider-model-picker.test.ts` — stale composer menu rejection.
- `infrastructure.test.ts` — dependency readiness (MCP, tunnel, browser/CDP), shared-start dedup, owned vs external resource lifecycle.
- `tunnel.test.ts` — tunnel binary resolution, health polling, owned-child lifecycle, credential handling (argv/env never logged).
- `auth.test.ts` — credential storage permissions/persistence.
- `browser-launcher.test.ts` — isolated profile launch args, CDP wait polling.
- `browser-session.test.ts` / `fresh-chat.test.ts` — pure ChatGPT state helpers (URL identity extraction, fail-closed state confirmation, fresh-chat detection).
- `config.test.ts` — config loading and planner-era field rejection.
- `path-safety.test.ts` — workspace path containment and traversal rejection.

Planner suite currently has 90 tests; core package suite has 159 tests.

## Manual/live checks (not in CI)

- `scripts/live-discovery-probe.ts` — real model discovery against configured CDP.
- `npm run doctor` — host prerequisites (Node, Git, Pi, CDP reachability).
- Live herdr run: confirm TUI gate, parallel independent workers, `correct` turn evidence on a reused pane, `stop` reaping panes.
