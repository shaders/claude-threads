/**
 * Chain state carried on a session, and what of it survives a restart.
 *
 * Only the ledger is persisted. Silence bookkeeping, the turn counter and the
 * timers are deliberately in-memory: after a restart we have not watched the
 * thread, so a `lastSeen` read from disk would claim knowledge we do not have —
 * and claiming the reviewer was seen two hours ago is worse than admitting we
 * just got here, because the first thing a fresh process should do is give the
 * owner the full silence window again rather than escalate on arrival.
 */

import type { ReviewVerdict } from './verify.js';
import type { Expectation } from './types.js';

export interface ChainSessionState {
  expectations: Expectation[];
  /** partyKey → last time that party was seen in this thread (epoch ms). */
  lastSeen: Record<string, number>;
  /** partyKeys whose bot announced it cannot answer (rate limit) in this thread. */
  stalled: string[];
  /** Completed turns of our own agent — the "once per turn" clock. */
  turns: number;
  /**
   * The last few things each party said in this thread (partyKey → posts), for
   * the one fuzzy question in the chain: did their review ask for changes or not.
   *
   * Kept as posts rather than one truncated string: a reviewer who streams a
   * status line per file can push its own verdict out of a character window,
   * and then the classification reads a list of filenames as a conclusion.
   */
  partyPosts: Record<string, string[]>;
  /**
   * Clock origin for silence windows (epoch ms), set when this state is created.
   *
   * Load-bearing after a restart. The ledger is persisted with absolute `since` /
   * `lastNudgeAt` stamps, but the process was not watching the thread while it was
   * down — so measuring silence from those stamps blames the reviewer for the
   * bot's own downtime, and the first unrelated post in the thread fires an
   * escalation. Silence is therefore never measured from before this moment.
   */
  clockBaseAt: number;
  /**
   * Review conclusion per MR, once classified. Cached because the answer cannot
   * change without the reviewer speaking again, and because "fixes" means we must
   * NOT keep asking the model whether an approval is owed.
   */
  verdicts: Record<string, ReviewVerdict>;
  /** Last approval answer per MR, with when we asked — see APPROVAL_CACHE_MS. */
  approvals: Record<string, { at: number; approved: boolean | null }>;
  /** MRs whose completion has already been reported to the human who asked. */
  reported: string[];
  /** In-flight guard: verification is async and must not overlap itself. */
  verifying?: boolean;
  /** When our last turn ended, for the quiescence check. */
  lastResultAt?: number;
  /** Periodic silence-window tick, while any foreign-owned step is open. */
  timer?: ReturnType<typeof setTimeout>;
  /** One-shot tick armed at turn end, so an agent-owned step fires promptly. */
  settleTimer?: ReturnType<typeof setTimeout>;
}

/** Persisted subset — the ledger, nothing else. */
export interface PersistedChainState {
  expectations: Expectation[];
}

export function createChainState(persisted?: PersistedChainState): ChainSessionState {
  return {
    expectations: persisted?.expectations ?? [],
    lastSeen: {},
    stalled: [],
    turns: 0,
    clockBaseAt: Date.now(),
    partyPosts: {},
    verdicts: {},
    approvals: {},
    reported: [],
  };
}
