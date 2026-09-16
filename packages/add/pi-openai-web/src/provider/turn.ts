import type { OpenAIWebModelDescriptor, ProviderTurnState } from "./types.js";

/**
 * Provider turn state machine:
 * idle -> bootstrapping -> submitted -> generating -> (waiting_for_pi_tool -> generating)* -> completed
 * Any pre-terminal state can move to failed/aborted. Illegal transitions throw.
 */
export class ProviderTurnController {
  private currentState: ProviderTurnState = "idle";
  private terminalError: string | undefined;

  readonly startedAtMs = Date.now();
  lastProgressAtMs = Date.now();

  constructor(
    readonly descriptor: OpenAIWebModelDescriptor,
    readonly targetId: string,
    readonly turnId: string,
    readonly promptFingerprint: string,
    readonly turnTimeoutMs: number,
    readonly stallTimeoutMs: number
  ) {}

  get state(): ProviderTurnState { return this.currentState; }
  get error(): string | undefined { return this.terminalError; }
  get isTerminal(): boolean { return ["completed", "failed", "aborted"].includes(this.currentState); }

  touchProgress(): void {
    this.lastProgressAtMs = Date.now();
  }

  transition(next: ProviderTurnState, error?: string): void {
    if (!ProviderTurnController.canTransition(this.currentState, next)) {
      throw new Error(`illegal_provider_turn_transition: ${this.currentState} -> ${next}`);
    }
    this.currentState = next;
    this.terminalError = next === "failed" || next === "aborted" ? error : undefined;
    this.touchProgress();
  }

  stalled(now = Date.now()): boolean {
    if (this.isTerminal) return false;
    return now - this.lastProgressAtMs > this.stallTimeoutMs;
  }

  expired(now = Date.now()): boolean {
    if (this.isTerminal) return false;
    return now - this.startedAtMs > this.turnTimeoutMs;
  }

  private static canTransition(from: ProviderTurnState, to: ProviderTurnState): boolean {
    if (["failed", "aborted"].includes(to)) return !["failed", "aborted", "completed"].includes(from);
    const allowed: Record<ProviderTurnState, ProviderTurnState[]> = {
      idle: ["bootstrapping", "submitted"],
      bootstrapping: ["submitted", "generating"],
      submitted: ["generating", "completed"],
      generating: ["waiting_for_pi_tool", "completed"],
      waiting_for_pi_tool: ["generating", "completed"],
      completed: [],
      failed: [],
      aborted: []
    };
    return allowed[from].includes(to);
  }
}
