/**
 * Caveman full response-style policy for the OpenAI Web provider.
 *
 * One dedicated module owns every Caveman string so runtime prompt assembly
 * never embeds duplicated style text. The full contract is inserted exactly
 * once per bootstrap through the single authoritative buildBootstrapPrompt
 * path (fresh initial conversation and post-compaction recycle both flow
 * through it, so the two bootstrap paths can never drift); bootstrapped
 * continuation turns carry only the compact reminder below.
 *
 * The policy shapes the model's visible answer style only. It never changes
 * model effort, Lead/Herdr orchestration, tool selection, safety behavior,
 * completion watching, or browser lifecycle. Behavior is fully deterministic
 * with no dependency on Pi skill discovery or the external caveman skill
 * catalog — the provider stays correct even when no skills are installed.
 */

/** The provider's default response style; Caveman full. No GUI/config persistence in this change. */
export const CAVEMAN_DEFAULT_STYLE = "full" as const;

/** Stable marker opening the full contract; used to count contract insertions per prompt. */
export const CAVEMAN_CONTRACT_MARKER = "CAVEMAN RESPONSE STYLE";

/**
 * The full Caveman full response-style contract. Inserted exactly once by
 * buildBootstrapPrompt, always before the task payload (latest user request
 * or compaction checkpoint).
 */
export const CAVEMAN_FULL_CONTRACT = [
  `${CAVEMAN_CONTRACT_MARKER} (${CAVEMAN_DEFAULT_STYLE}, default for this provider, always on):`,
  "This is your visible answer style only — it never changes model effort, Lead/Herdr delegation, tool selection, safety behavior, or task completion.",
  "Answer short and dense. Lead with the direct conclusion or the next action. No restatement of the request, no preamble, no filler, no repetition; sentence fragments are fine when they are clearer than full sentences.",
  "Never trade correctness for brevity: reproduce code, commands, file paths, and error text exactly, and keep every correctness-critical detail (edge cases, invariants, caveats).",
  "Expand detail, explanation, formatting, or verbosity only when correctness or safety requires it, or when the user explicitly asks for more detail, an explanation, a specific format, or more verbosity — that explicit request overrides the concise default for that turn."
].join("\n");

/**
 * Compact per-turn reminder for bootstrapped continuation turns. Resends the
 * policy essence without ever repeating the full contract text.
 */
export const CAVEMAN_CONTINUATION_REMINDER = "[CAVEMAN: full] Answers stay short and dense: conclusion or action first, no preamble/filler/repetition; keep code, commands, paths, and error text exact; expand only when correctness/safety requires it or the user explicitly asks for that turn.]";
