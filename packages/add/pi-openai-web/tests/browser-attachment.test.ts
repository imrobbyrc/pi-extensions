import assert from "node:assert/strict";
import test from "node:test";
import { isAppAttachmentConfirmed } from "../src/browser/chatgpt.js";

test("confirms Pi Workspace from composer attachment signals", () => {
  assert.equal(
    isAppAttachmentConfirmed({ signals: ["Pi Workspace", "data-type=mention"] }, "Pi Workspace"),
    true
  );
});

test("does not treat unrelated composer state as app attachment", () => {
  assert.equal(isAppAttachmentConfirmed({ signals: ["@Pi Workspace"] }, "Other App"), false);
  assert.equal(isAppAttachmentConfirmed({ signals: ["planning prompt"] }, "Pi Workspace"), false);
});
