import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Provider,
  type SimpleStreamOptions
} from "@earendil-works/pi-ai";import type { OpenAIWebModelDescriptor } from "./types.js";
import type { OpenAIWebRuntime } from "./runtime.js";
import type { OpenAIWebModelCatalog } from "./catalog.js";

export const OPENAI_WEB_PROVIDER_ID = "openai-web";
/** Subscription-backed ChatGPT Web: zero marginal cost; conservative display window. */
export const OPENAI_WEB_CONTEXT_WINDOW = 128_000;

/** Map a discovered descriptor to a Pi Model. Never invents provider facts. */
export function toPiModel(descriptor: OpenAIWebModelDescriptor): Model<"openai-web"> {
  return {
    id: descriptor.id,
    name: descriptor.effort ? `${descriptor.displayName} (${descriptor.effort})` : descriptor.displayName,
    api: "openai-web",
    provider: OPENAI_WEB_PROVIDER_ID,
    baseUrl: "https://chatgpt.com/",
    reasoning: descriptor.effort !== null,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: OPENAI_WEB_CONTEXT_WINDOW,
    maxTokens: OPENAI_WEB_CONTEXT_WINDOW
  };
}

export interface OpenAIWebProviderDeps {
  runtime: OpenAIWebRuntime;
  catalog: OpenAIWebModelCatalog;
  /** Called after the model list changed so the UI can show the new entries. */
  onCatalogChanged?: (source: "cache" | "live", count: number) => void;
}

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

function readTextBlock(output: AssistantMessage, index: number): string | undefined {
  const block = output.content[index];
  return block && block.type === "text" ? block.text : undefined;
}

function closeTextBlock(stream: ReturnType<typeof createAssistantMessageEventStream>, output: AssistantMessage, index: number): void {
  const text = readTextBlock(output, index);
  if (text !== undefined) stream.push({ type: "text_end", contentIndex: index, content: text, partial: output });
}

/** stream and streamSimple share the browser turn implementation. */
export function streamTurn(model: Model<"openai-web">, context: Context, options: SimpleStreamOptions | undefined, deps: OpenAIWebProviderDeps): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage(),
      stopReason: "pending",
      timestamp: Date.now()
    };
    let textIndex = -1;
    let emittedTextLength = 0;
    const ensureTextBlock = (): number => {
      if (textIndex === -1) {
        output.content.push({ type: "text", text: "" });
        textIndex = output.content.length - 1;
        stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
      }
      return textIndex;
    };
    const appendText = (full: string): void => {
      const index = ensureTextBlock();
      const delta = full.slice(emittedTextLength);
      if (!delta) return;
      emittedTextLength = full.length;
      const block = output.content[index];
      if (block?.type === "text") block.text = full;
      stream.push({ type: "text_delta", contentIndex: index, delta, partial: output });
    };

    try {
      stream.push({ type: "start", partial: output });
      const descriptor = deps.runtime.resolveDescriptor(model.id);
      const outcome = await deps.runtime.runTurn(
        descriptor,
        { ...(context.systemPrompt !== undefined ? { systemPrompt: context.systemPrompt } : {}), messages: context.messages },
        { onText: appendText },
        ...(options?.signal ? [{ signal: options.signal }] : [])
      );

      if (outcome.kind === "failed") throw new Error(outcome.error);

      appendText(outcome.markdown);
      if (textIndex !== -1) closeTextBlock(stream, output, textIndex);
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

/**
 * Catalog-driven openai-web provider. Model list comes from OpenAIWebModelCatalog;
 * streamSimple drives browser turns through OpenAIWebRuntime.
 */
export function createOpenAIWebProvider(deps: OpenAIWebProviderDeps): { provider: Provider; setCatalog: (descriptors: OpenAIWebModelDescriptor[]) => void } {
  let models: Model<"openai-web">[] = [];

  const setCatalog = (descriptors: OpenAIWebModelDescriptor[]): void => {
    models = descriptors.map(toPiModel);
  };

  const provider: Provider = {
    id: OPENAI_WEB_PROVIDER_ID,
    name: "ChatGPT Web (openai-web)",
    baseUrl: "https://chatgpt.com/",
    auth: {
      apiKey: {
        name: "ChatGPT Web (browser session)",
        // Ambient auth: the logged-in browser profile is the credential. Never resolves secrets.
        resolve: async () => ({ auth: { apiKey: "chatgpt-web-session" }, source: "ChatGPT Web browser session" })
      }
    },
    getModels: () => models,
    refreshModels: async (context) => {
      if (!deps.catalog.shouldRefresh()) return;
      const result = await deps.catalog.refresh();
      if (context.signal.aborted) return;
      if (!result.ok) return; // keep previous list; cache remains last-known-good
      const refreshed = result.models.map(toPiModel);
      await context.publish({
        update: () => {
          models = refreshed;
          deps.onCatalogChanged?.("live", refreshed.length);
        }
      });
    },
    stream: (model, context, options) => streamTurn(model as Model<"openai-web">, context, options as SimpleStreamOptions | undefined, deps),
    streamSimple: (model, context, options) => streamTurn(model as Model<"openai-web">, context, options, deps)
  };

  return { provider, setCatalog };
}
