import assert from "node:assert/strict";
import test from "node:test";
import { ensureTemporaryChat, isTemporaryChat, type CdpClient } from "../src/provider/page.js";

/**
 * Temporary Chat confirmation. The `temporary-chat=true` URL parameter is
 * navigation *intent*, not evidence: a page that failed to enter Temporary Chat
 * must never be confirmed as temporary. The CDP double below executes the exact
 * page expressions production code ships against a scripted DOM, so the
 * confirmation predicates are exercised for real instead of pattern-matched.
 */
interface MiniPage {
  href: string;
  turnOffVisible: boolean;
  saveChatVisible: boolean;
  temporaryToggleVisible: boolean;
  composerVisible: boolean;
}

function miniBrowser(page: MiniPage): { client: CdpClient; navigations: string[] } {
  const visibleElement = (): { offsetParent: unknown; click: () => void } => ({ offsetParent: {}, click: () => {} });
  const querySelector = (selector: string): { offsetParent: unknown; click: () => void } | null => {
    if (selector === 'button[aria-label="Turn off temporary chat"]') return page.turnOffVisible ? visibleElement() : null;
    if (selector === 'button[aria-label="Save chat"]') return page.saveChatVisible ? visibleElement() : null;
    if (selector === 'button[aria-label="Temporary chat"]') return page.temporaryToggleVisible ? visibleElement() : null;
    if (selector === '[contenteditable="true"]') return page.composerVisible ? visibleElement() : null;
    return null;
  };
  const navigations: string[] = [];
  const client = {
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        const documentDouble = {
          querySelector,
          querySelectorAll: (selector: string) => {
            const found = querySelector(selector);
            return found ? [found] : [];
          }
        };
        const locationDouble = { href: page.href };
        const runPageExpression = new Function("document", "location", `"use strict"; return (${expression});`);
        try {
          return { result: { value: runPageExpression(documentDouble, locationDouble) } };
        } catch {
          return { result: { value: undefined } };
        }
      }
    },
    Page: {
      navigate: async ({ url }: { url: string }) => {
        navigations.push(url);
        page.href = url;
      }
    }
  } as unknown as CdpClient;
  return { client, navigations };
}

test("isTemporaryChat requires DOM evidence; the temporary-chat URL parameter alone is not confirmation", async () => {
  // Real observed bug: the page carries temporary-chat=true (navigation intent)
  // but shows no Temporary Chat controls. Confirming it lets a non-temporary
  // target pass the security gate.
  const { client } = miniBrowser({
    href: "https://chatgpt.com/?temporary-chat=true",
    turnOffVisible: false,
    saveChatVisible: false,
    temporaryToggleVisible: false,
    composerVisible: true
  });
  assert.equal(await isTemporaryChat(client), false);
});

test("isTemporaryChat still confirms on visible Temporary Chat controls", async () => {
  const withTurnOff = miniBrowser({
    href: "https://chatgpt.com/",
    turnOffVisible: true,
    saveChatVisible: false,
    temporaryToggleVisible: false,
    composerVisible: true
  });
  assert.equal(await isTemporaryChat(withTurnOff.client), true);

  const withSaveChat = miniBrowser({
    href: "https://chatgpt.com/",
    turnOffVisible: false,
    saveChatVisible: true,
    temporaryToggleVisible: false,
    composerVisible: true
  });
  assert.equal(await isTemporaryChat(withSaveChat.client), true);
});

test("isTemporaryChat fails closed on a normal conversation URL even with temporary controls", async () => {
  const { client } = miniBrowser({
    href: "https://chatgpt.com/c/6aaaa781-ab58-83ec-8a2c-a8ca1333e221?temporary-chat=true",
    turnOffVisible: true,
    saveChatVisible: true,
    temporaryToggleVisible: false,
    composerVisible: true
  });
  assert.equal(await isTemporaryChat(client), false);
});

test("ensureTemporaryChat fails closed when navigation lands on a non-temporary page", async () => {
  // The page never renders Temporary Chat controls, before or after navigating
  // to the temporary-chat URL. ensureTemporaryChat must report failure so the
  // provider turn fails closed instead of prompting a persistent chat.
  const { client, navigations } = miniBrowser({
    href: "https://chatgpt.com/",
    turnOffVisible: false,
    saveChatVisible: false,
    temporaryToggleVisible: false,
    composerVisible: true
  });
  const ensured = await ensureTemporaryChat(client, "https://chatgpt.com/");
  assert.equal(ensured, false);
  assert.ok(navigations.length >= 1, "must attempt navigation before failing closed");
});

test("ensureTemporaryChat succeeds by clicking the visible Temporary chat toggle", async () => {
  const page = {
    href: "https://chatgpt.com/",
    turnOffVisible: false,
    saveChatVisible: false,
    temporaryToggleVisible: true,
    composerVisible: true
  };
  const { client } = miniBrowser(page);
  const clicking = {
    Runtime: {
      evaluate: async (args: { expression: string }) => {
        // Clicking the visible "Temporary chat" toggle enters Temporary Chat:
        // the turn-off control appears on the next poll.
        if (args.expression.includes('button[aria-label="Temporary chat"]')) {
          page.temporaryToggleVisible = false;
          page.turnOffVisible = true;
        }
        return client.Runtime.evaluate(args);
      }
    },
    Page: client.Page
  } as unknown as CdpClient;
  assert.equal(await ensureTemporaryChat(clicking, "https://chatgpt.com/"), true);
});
