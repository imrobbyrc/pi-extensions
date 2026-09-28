import assert from "node:assert/strict";
import test from "node:test";
import { openModelPicker, readPickerTriggerLabel } from "../src/provider/model-picker.js";
import type { CdpClient } from "../src/provider/page.js";

/** Minimal CDP double for the picker-open probe. */
function pickerClient(state: { modelRows: boolean; staleMenu: boolean }): CdpClient {
  const client = {
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        // The old probe treated any visible menuitem as the model picker. Keep
        // the stale-menu signal true so this regression test fails against that
        // implementation while the model rows remain absent.
        if (expression.includes('[role="menuitemradio"], [role="menuitem"]')) {
          return { result: { value: state.staleMenu } };
        }
        if (expression.includes("querySelectorAll('[role=\"menuitemradio\"]')")) {
          return { result: { value: state.modelRows } };
        }
        if (expression.includes('const el = (')) {
          return { result: { value: { x: 20, y: 20 } } };
        }
        if (expression.includes('FIND_TRIGGER') || expression.includes('data-composer-transition-slot')) {
          return { result: { value: true } };
        }
        return { result: { value: false } };
      }
    },
    Input: {
      dispatchMouseEvent: async ({ type }: { type: string }) => {
        if (type === 'mouseReleased') state.modelRows = true;
      },
      dispatchKeyEvent: async () => undefined
    }
  } as unknown as CdpClient;
  return client;
}

test("openModelPicker ignores a stale unrelated menu and opens the model picker", async () => {
  const state = { modelRows: false, staleMenu: true };
  assert.equal(await openModelPicker(pickerClient(state)), true);
  assert.equal(state.modelRows, true);
});

test("readPickerTriggerLabel supports ChatGPT's labelled model button", async () => {
  let expression = "";
  const client = {
    Runtime: {
      evaluate: async ({ expression: value }: { expression: string }) => {
        expression = value;
        return { result: { value: value.includes('Select ChatGPT model') ? 'Thinking effortMedium' : null } };
      }
    }
  } as unknown as CdpClient;
  assert.equal(await readPickerTriggerLabel(client), "Thinking effortMedium");
  assert.match(expression, /Select ChatGPT model/);
});
