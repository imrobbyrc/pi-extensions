import assert from "node:assert/strict";
import test from "node:test";
import { evalJson, readTurnState, submitPrompt, type CdpClient } from "../src/provider/page.js";

test("submitPrompt clicks Send and returns the exact confirmed new user identity", async () => {
  let sent = false;
  const actions: string[] = [];
  const client = {
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("const containers =")) return { result: { value: {
          turnIdentities: sent ? ["old", "new"] : ["old"],
          userIdentities: sent ? ["old", "new"] : ["old"],
          responseIdentities: [], stopVisible: false, busy: false, url: ""
        } } };
        if (expression.includes("button.click()")) {
          sent = true;
          actions.push("click");
          return { result: { value: true } };
        }
        if (expression.includes("el.focus()")) return { result: { value: true } };
        return { result: { value: false } };
      }
    },
    Input: { insertText: async ({ text }: { text: string }) => { actions.push(`insert:${text}`); } }
  } as never;
  const confirmed = await submitPrompt(client, "review");
  assert.deepEqual(actions, ["insert:review", "click"]);
  // The causal anchor for response binding: the exact newly confirmed user
  // identity, not a display index or a pre-submit guess.
  assert.equal(confirmed, "new");
});

test("browser exceptions propagate instead of becoming an empty conversation", async () => {
  const client = { Runtime: { evaluate: async () => ({
    result: { type: "object", subtype: "error" },
    exceptionDetails: { text: "Uncaught", exception: { description: "Error: ChatGPT conversation turn has no stable logical identity" } }
  }) } } as never;
  await assert.rejects(evalJson(client, "() => { throw Error('bad state'); }"), /no stable logical identity/);
  await assert.rejects(readTurnState(client), /no stable logical identity/);
});

test("missing DOM snapshot fails closed rather than inventing an empty baseline", async () => {
  const client = { Runtime: { evaluate: async () => ({ result: {} }) } } as never;
  await assert.rejects(readTurnState(client), /conversation state unavailable/);
});

test("cancelled submission never touches the browser", async () => {
  const client = { Runtime: { evaluate: async () => { assert.fail("browser touched after abort"); } } } as never;
  await assert.rejects(submitPrompt(client, "review", { signal: AbortSignal.abort() }), { name: "AbortError" });
});

test("cancellation during insertion prevents Send", async () => {
  const abort = new AbortController();
  let clicks = 0;
  const client = {
    Runtime: { evaluate: async ({ expression }: { expression: string }) => {
      if (expression.includes("const containers =")) return { result: { value: { userIdentities: [] } } };
      if (expression.includes("button.click()")) { clicks++; return { result: { value: true } }; }
      return { result: { value: expression.includes("el.focus()") } };
    } },
    Input: { insertText: async () => abort.abort() }
  } as unknown as CdpClient;
  await assert.rejects(submitPrompt(client, "review", { signal: abort.signal }), { name: "AbortError" });
  assert.equal(clicks, 0);
});

test("confirmation timeout retains DOM failure and never resubmits", async (t) => {
  let now = 0;
  let clicks = 0;
  t.mock.method(Date, "now", () => (now += clicks ? 6_000 : 0));
  const client = {
    Runtime: { evaluate: async ({ expression }: { expression: string }) => {
      if (expression.includes("const containers =")) {
        if (!clicks) return { result: { value: { userIdentities: [] } } };
        return { result: {}, exceptionDetails: { text: "Uncaught", exception: { description: "Error: unstable turn identity" } } };
      }
      if (expression.includes("button.click()")) { clicks++; return { result: { value: true } }; }
      return { result: { value: expression.includes("el.focus()") } };
    } },
    Input: { insertText: async () => {} }
  } as unknown as CdpClient;
  await assert.rejects(submitPrompt(client, "review"), /did not confirm.*unstable turn identity.*before retrying/s);
  assert.equal(clicks, 1);
});
