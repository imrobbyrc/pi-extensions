import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { streamTurn, OPENAI_WEB_PROVIDER_ID, toPiModel } from "../src/provider/provider.js";
import type { OpenAIWebRuntime } from "../src/provider/runtime.js";
import type { OpenAIWebModelDescriptor } from "../src/provider/types.js";

function descriptor(id = "gpt-5-6-sol-high"): OpenAIWebModelDescriptor {
  return {
    id, displayName: "GPT-5.6 Sol", browserModelLabel: "GPT-5.6 Sol", effort: "High",
    source: "live", discoveredAt: new Date().toISOString(), selectable: true, capabilityState: "unknown"
  };
}

interface FakeTurnCall {
  descriptorId: string;
  messages: unknown[];
  handlers: Parameters<OpenAIWebRuntime["runTurn"]>[2];
}

type ScriptedOutcome = Awaited<ReturnType<OpenAIWebRuntime["runTurn"]>>;

/** Minimal runtime stand-in: records runTurn calls, returns scripted outcomes. */
function fakeRuntime(outcomes: ScriptedOutcome[], calls: FakeTurnCall[], known: OpenAIWebModelDescriptor[]): OpenAIWebRuntime {
  let index = 0;
  return {
    resolveDescriptor: (id: string) => {
      const found = known.find(model => model.id === id);
      if (!found) throw new Error(`unknown_model: ${id}`);
      return found;
    },
    runTurn: async (d: OpenAIWebModelDescriptor, context: { messages: unknown[] }, handlers: FakeTurnCall["handlers"]) => {
      calls.push({ descriptorId: d.id, messages: context.messages, handlers });
      return outcomes[index++]!;
    }
  } as unknown as OpenAIWebRuntime;
}

function drain(stream: ReturnType<typeof createAssistantMessageEventStream>, events: unknown[]): Promise<void> {
  return (async () => {
    try {
      for await (const event of stream) events.push(event);
    } catch {
      // error terminal surfaces as events, not exceptions
    }
  })();
}

const model = toPiModel(descriptor());

test("provider id and model metadata stay honest", () => {
  assert.equal(OPENAI_WEB_PROVIDER_ID, "openai-web");
  assert.equal(model.api, "openai-web");
  assert.equal(model.provider, "openai-web");
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(model.input, ["text"]);
  const noEffort = toPiModel({ ...descriptor("x"), effort: null });
  assert.equal(noEffort.reasoning, false);
});

test("completed turn returns final text with stop reason", async () => {
  const calls: FakeTurnCall[] = [];
  const runtime = fakeRuntime([{ kind: "completed", markdown: "# Answer\nDone." }], calls, [descriptor()]);
  const stream = streamTurn(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, undefined, { runtime, catalog: {} as never });
  const events: unknown[] = [];
  await drain(stream, events);
  assert.equal(calls.length, 1);
  assert.deepEqual(events.map(event => (event as { type: string }).type), ["start", "text_start", "text_delta", "text_end", "done"]);
  const done = events.at(-1) as { reason: string; message: { stopReason: string; content: Array<{ type: string; text?: string }> } };
  assert.equal(done.reason, "stop");
  assert.equal(done.message.stopReason, "stop");
  assert.equal(done.message.content[0]?.text, "# Answer\nDone.");
});

;

test("unknown model id fails explicitly and never routes to a default", async () => {
  const calls: FakeTurnCall[] = [];
  const runtime = fakeRuntime([], calls, []);
  const stream = streamTurn(toPiModel(descriptor("not-in-catalog")), { messages: [] }, undefined, { runtime, catalog: {} as never });
  const events: unknown[] = [];
  await drain(stream, events);
  const error = events.at(-1) as { type: string; error: { stopReason: string; errorMessage?: string } };
  assert.equal(error.type, "error");
  assert.match(error.error.errorMessage ?? "", /unknown_model/);
});

test("failed turn surfaces runtime error message", async () => {
  const calls: FakeTurnCall[] = [];
  const runtime = fakeRuntime([{ kind: "failed", error: "provider_turn_stalled" }], calls, [descriptor()]);
  const stream = streamTurn(model, { messages: [] }, undefined, { runtime, catalog: {} as never });
  const events: unknown[] = [];
  await drain(stream, events);
  const error = events.at(-1) as { error: { errorMessage?: string } };
  assert.equal(error.error.errorMessage, "provider_turn_stalled");
});

test("streaming snapshot rewrites and shrinks replace the streamed text", async () => {
  // ChatGPT re-renders a turn mid-stream: the watched DOM snapshot can shrink
  // ("abcdef" -> "abc") or rewrite in place ("abc" -> "axc"). The public
  // output path must replace the emitted text for such snapshots while normal
  // growing snapshots keep streaming as plain deltas.
  const runtime = {
    resolveDescriptor: () => descriptor(),
    runTurn: async (
      _d: OpenAIWebModelDescriptor,
      _c: { messages: unknown[] },
      handlers: FakeTurnCall["handlers"]
    ) => {
      handlers.onText?.("abcdef");
      handlers.onText?.("abc");
      handlers.onText?.("axc");
      return { kind: "completed" as const, markdown: "axc" };
    }
  } as unknown as OpenAIWebRuntime;
  const stream = streamTurn(model, { messages: [] }, undefined, { runtime, catalog: {} as never });
  const events: unknown[] = [];
  await drain(stream, events);

  // The final message must carry the last snapshot, never the stale longer text.
  const done = events.at(-1) as { message: { content: Array<{ type: string; text?: string }> } };
  assert.equal(done.message.content[0]?.text, "axc");

  const typed = events as Array<{ type: string; delta?: string; content?: string }>;
  // Normal append stays a plain delta; each replace re-opens the block and
  // replays the corrected snapshot (pi-ai consumers reset on text_start).
  assert.deepEqual(
    typed.map(event => event.type),
    ["start", "text_start", "text_delta", "text_start", "text_delta", "text_start", "text_delta", "text_end", "done"]
  );
  assert.deepEqual(typed.filter(e => e.type === "text_delta").map(e => e.delta), ["abcdef", "abc", "axc"]);

  // Replay with pi-ai consumer semantics (text_start resets, text_delta appends).
  let replayed = "";
  for (const event of typed) {
    if (event.type === "text_start") replayed = "";
    else if (event.type === "text_delta") replayed += event.delta ?? "";
  }
  assert.equal(replayed, "axc");
});
