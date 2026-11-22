/**
 * Event and message-source vocabulary of the consciousness scaffold.
 *
 * @module @pseudo-agi/scaffold/events
 */

/** Emitted for every turn's first step, whether or not a discipline was injected. */
export interface PseudoAgiScaffoldStepEvent {
  /** Session whose step was scoped. */
  readonly sessionId: string
  /** Turn number. */
  readonly turn: number
  /** Step number within the turn. */
  readonly step: number
  /** Whether the discipline message was actually injected into this step. */
  readonly injected: boolean
  /** ISO timestamp. */
  readonly at: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One scaffold observation. Observational only: listeners cannot change the
     * step, and the scaffold itself never changes the loop's decision.
     * @param payload - which step was scoped and whether it carried a discipline.
     * @mode emit
     */
    'pseudo-agi/scaffold-step'(payload: PseudoAgiScaffoldStepEvent): void
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * A discipline injected by the scaffold. Model-visible content must travel
     * through logged channels, so this is a real user message with its own
     * source and a one-line account of what it is.
     */
    'pseudo-agi-scaffold': {
      kind: 'pseudo-agi-scaffold'
      form: 'notice'
      summary: string
    }
  }
}
