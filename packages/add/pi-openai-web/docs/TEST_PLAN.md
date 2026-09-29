# Test plan

Run everything with:

```bash
npm run typecheck
npm test
```

## Unit coverage by suite

- `@imrobbyrc/pi-core-subagent` — package API, scheduler/DAG, Herdr runtime, steering, resume and cancellation; run its separate `bun test` suite.
- `herdr-gate.test.ts` — plan/run binding, gates, work-graph limits, confirmation and toggle enforcement.
- `herdr-review-flow.test.ts` — same-pane correction, observational verification, risk-bound accept and freshness checks.
- `subagent-adapter.test.ts` — minimal worker prompt projection, replay protection and concurrency plumbing.
- `orchestrator.test.ts` — profile persistence, v1/v2 plan shapes, risk–planning pairing, optional v2-low gates, fingerprint binding, prompt budget and 1–4 CLI limits.
- `orchestrator-gui.test.ts` — TUI settings (model picker, 1–4 concurrency, toggles, save/apply).
- `provider-catalog.test.ts` — deterministic model ids, cache TTLs, last-known-good cache behavior, schema versioning.
- `provider-features.test.ts` — session store, resume metadata, picker state freshness, compaction checkpoints.
- `provider-runtime-units.test.ts` — markdown extraction bounds, bootstrap context bounds, per-turn message batching, turn controller state machine.
- `provider-stream.test.ts` — provider id/model honesty, turn completion/tool-pending/failure events, unknown model ids fail explicitly.
- `provider-latency.test.ts` / `slow-turn-resilience.test.ts` — latency and slow-turn behavior.
- `temporary-chat-turn.test.ts` / `browser-attachment.test.ts` — temporary-chat and browser attachment flows.
- `provider-model-picker.test.ts` — stale composer menu rejection.
- `infrastructure.test.ts` — dependency readiness (MCP, tunnel, browser/CDP), shared-start dedup, owned vs external resource lifecycle.
- `tunnel.test.ts` — tunnel binary resolution, health polling, owned-child lifecycle, credential handling (argv/env never logged).
- `auth.test.ts` — credential storage permissions/persistence.
- `browser-launcher.test.ts` — isolated profile launch args, CDP wait polling.
- `browser-session.test.ts` / `fresh-chat.test.ts` — pure ChatGPT state helpers (URL identity extraction, fail-closed state confirmation, fresh-chat detection).
- `page-temporary-chat.test.ts` — Temporary Chat confirmation requires visible DOM evidence; the `temporary-chat=true` URL parameter alone fails closed (isTemporaryChat/ensureTemporaryChat against a scripted CDP double).
- `workspace-search.test.ts` — search_workspace glob is enforced by the rg-free JS fallback (gitignore-style subset) or fails closed; scope never widens.
- `config.test.ts` — config loading and planner-era field rejection.
- `path-safety.test.ts` / `workspace-files.test.ts` — workspace path containment, traversal rejection and bounded reads.

Use the current output of `npm test` for test counts; do not rely on historical totals.

## Manual/live checks (not in CI)

- `scripts/live-discovery-probe.ts` — real model discovery against configured CDP.
- `npm run doctor` — host prerequisites (Node, Git, Pi, CDP reachability).
- Low v2: compact plan without gates → run with identical authority → inspect diff → accept with bound handoff and no fingerprint. Check wrong handoff fails.
- Medium/high and v1: full graph/gates or legacy handoff → run → verify → fresh-fingerprint accept. Change the workspace or correct the worker before accept; stale fingerprints must fail.
- Concurrency: two independent workers at configured limit 1 run serially; raising the limit permits concurrent ready workers. Verify ownership and DAG checks remain active.
- Correction: reuse the same pane, re-review, then verify and accept strict work. Confirm TUI approval and pane cleanup.
- Adaptive effort: low uses `worker_thinking=low`, medium/high uses `high`; an explicit user setting wins without rewriting persisted config. `adaptivePlanning=false` retains full-graph guidance. `verificationGate=false` does not remove semantic diff review.
