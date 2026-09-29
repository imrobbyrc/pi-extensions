import assert from "node:assert/strict";
import test from "node:test";
import { submitPrompt } from "../src/provider/page.js";

test("submitPrompt clicks Send and waits for a new user turn", async () => {
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
  await submitPrompt(client, "review");
  assert.deepEqual(actions, ["insert:review", "click"]);
});
