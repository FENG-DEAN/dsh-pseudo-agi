/**
 * Event and message-source vocabulary of the controller.
 *
 * @module @pseudo-agi/controller/events
 */

import type { Route } from './router.js'

/** Emitted for every routing decision, whether or not a directive was injected. */
export interface PseudoAgiControllerDecisionEvent {
  /** Session whose step was routed. */
  readonly sessionId: string
  /** Turn number of the step. */
  readonly turn: number
  /** Step number within the turn. */
  readonly step: number
  /** Chosen route. */
  readonly route: Route
  /** Why that route was chosen. */
  readonly reason: string
  /** Whether a directive message was actually injected. */
  readonly injected: boolean
  /** ISO timestamp of the decision. */
  readonly at: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One controller routing decision, observational only.
     * @param payload - the route and whether it was injected.
     * @mode emit
     */
    'pseudo-agi/controller-decision'(payload: PseudoAgiControllerDecisionEvent): void
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * A directive injected by the routing controller. Model-visible content must
     * travel through logged channels, so the injection is a real user message
     * with its own source and a one-line account.
     */
    'pseudo-agi-controller': {
      kind: 'pseudo-agi-controller'
      form: 'notice'
      summary: string
    }
  }
}
