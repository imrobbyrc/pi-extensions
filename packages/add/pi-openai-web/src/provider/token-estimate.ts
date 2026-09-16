import { get_encoding, type Tiktoken } from "tiktoken";

const CHUNK_CHARS = 4_096;
let encoding: Tiktoken | undefined;

function tokenizer(): Tiktoken {
  encoding ??= get_encoding("o200k_base");
  return encoding;
}

function countText(text: string): number {
  let count = 0;
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) end -= 1;
    count += tokenizer().encode_ordinary(text.slice(start, end)).length;
    start = end;
  }
  return count;
}

/** Conservative o200k count; independent chunks avoid cross-boundary undercounting. */
export function estimateTokens(...texts: Array<string | undefined>): number {
  return texts.reduce((total, text) => total + (text ? countText(text) : 0), 0);
}

export function estimateMessages(messages: unknown[]): number {
  return estimateTokens(...messages.map(message => JSON.stringify(message)));
}
