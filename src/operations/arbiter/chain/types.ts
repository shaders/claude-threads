/**
 * Review-chain types — who is waiting for what, and who can act on it.
 *
 * The delivery ledger the arbiter already keeps answers "did my agent deliver
 * what the user asked for". It cannot express the fleet's actual failure mode,
 * which spans two processes on two hosts: a human asks, a bot works and opens an
 * MR, the reviewer must be called, must answer, must approve, must hand back,
 * and the first bot must tell the human. Every one of those steps has exactly one
 * party that can perform it, and a different party waiting on it. Drop any link
 * and the task dies silently in a channel nobody watches.
 *
 * Two rules shape everything here:
 *
 * 1. **The owner is who can act.** We nag our own agent by injecting a message;
 *    we reach another bot only by mentioning it in this thread (the one thing
 *    that wakes its session); a human only by @mention. An expectation whose
 *    owner we cannot reach is not a reminder, it is an escalation.
 *
 * 2. **Closure is an event, not a deadline.** Our own turn ends with `result`;
 *    the reviewer's arrival, its hand-back and its rate-limit notice are all
 *    posts we can see; the approval is a fact in GitLab. Timers exist only as a
 *    missing-owner detector, measured as a sliding silence window — so a
 *    reviewer that is visibly working is never interrupted, and one that died is
 *    noticed in minutes rather than half an hour.
 */

/** Who owes or awaits a step. Names are matched case-insensitively. */
export type Party =
  | { kind: 'agent' }
  | { kind: 'bot'; name: string }
  | { kind: 'human'; name: string };

/**
 * Stable key for a party, used for silence bookkeeping and dedupe. Our own agent
 * has no name: there is exactly one per session.
 */
export function partyKey(party: Party): string {
  return party.kind === 'agent' ? 'agent' : `${party.kind}:${party.name.toLowerCase()}`;
}

/** Human-readable party label for logs and thread posts. */
export function partyLabel(party: Party): string {
  return party.kind === 'agent' ? 'агент' : `@${party.name}`;
}

/**
 * The links of the chain. Kind is what the step IS, not who does it: the same
 * `mr_approved` is owned by our own agent when we are the reviewer, and by the
 * reviewer bot when we are the one waiting.
 */
export type ExpectationKind =
  /** An MR exists and the reviewer must be asked to look at it. */
  | 'review_requested'
  /** The reviewer must show up in the thread at all. */
  | 'review_reply'
  /** A review that found nothing must end in an approval in GitLab. */
  | 'mr_approved'
  /** The reviewer must tell the requester the review is done. */
  | 'review_handback'
  /** The human who asked must be told the task is finished. */
  | 'task_report';

export type ExpectationState = 'open' | 'satisfied' | 'waived' | 'failed';

export interface Expectation {
  /** `${kind}:${subject}` — stable, so arming the same step twice is a no-op. */
  id: string;
  kind: ExpectationKind;
  owner: Party;
  waiter: Party;
  /** What the step is about — an MR url, or undefined for subject-less steps. */
  subject?: string;
  state: ExpectationState;
  /** When the expectation was armed (epoch ms). Also the first silence baseline. */
  since: number;
  /** Reminders already sent to the owner. */
  reminders: number;
  /** Last time we nudged the owner — restarts the silence window. */
  lastNudgeAt?: number;
  /**
   * Turn number our own agent was last nudged on (see ChainFacts.selfTurns).
   *
   * An agent-owned step has no silence window — its trigger is "a turn ended" —
   * so without this the ladder runs itself out on whatever ticks happen to land
   * while the agent is composing its reply. One nudge per completed turn: the
   * agent gets a whole turn to comply before it hears from us again.
   */
  lastNudgeTurn?: number;
  /** Why it ended, for the thread post and the logs. */
  resolution?: string;
}

/**
 * Everything the reducer is allowed to know about the world, gathered by the
 * caller. Pure input: no session, no platform, no clock of its own — which is
 * what makes the whole chain testable without processes.
 */
export interface ChainFacts {
  now: number;
  /**
   * Expectation ids observed as met since the last tick. Deterministic
   * satisfaction only — a delivered ping, an approval in GitLab, a post from the
   * reviewer. Never a model's opinion that something looks done.
   */
  satisfiedIds: string[];
  /**
   * Last time each party was seen doing anything in this thread
   * (partyKey → epoch ms). A post, an edited post: both count, because a bot
   * mid-task updates its rolling tool line far more often than it posts anew.
   */
  lastSeen: Record<string, number>;
  /**
   * Parties known to be unable to answer — their bot announced a rate limit in
   * the thread. Reminding them is pointless by construction, so these go
   * straight to the humans.
   */
  stalled: string[];
  /** Our own turn ended and the session has stayed quiet since (quiescence passed). */
  selfSettled: boolean;
  /** Our own agent is mid-turn. Never inject a message into a running turn. */
  selfProcessing: boolean;
  /**
   * Completed turns of our own agent so far — a monotonic counter, not a clock.
   * This is what makes "once per turn" expressible without a timer: two ticks
   * inside one turn carry the same number, so only the first can nudge.
   */
  selfTurns: number;
}

export interface ChainPolicy {
  /**
   * Silence allowed before we conclude the owner never woke up. Small on
   * purpose: a mention wakes a teammate's session at once, so silence here means
   * dead, rate-limited, or a mention that did not land.
   */
  awakeSilenceMs: number;
  /**
   * Silence allowed after the owner HAS shown up. Longer, because a reviewer
   * reading a diff is legitimately quiet between posts — but bounded, because a
   * process that died mid-review looks exactly the same from here.
   */
  workSilenceMs: number;
  /** Nudges to the owner before the humans are told instead. */
  maxReminders: number;
}

export const DEFAULT_CHAIN_POLICY: ChainPolicy = {
  awakeSilenceMs: 2 * 60_000,
  workSilenceMs: 5 * 60_000,
  maxReminders: 2,
};

/**
 * What the reducer decided to do. Declarative so the executor stays a thin,
 * separately testable adapter — and so a test can assert the decision without
 * standing up a platform.
 */
export type ChainAction =
  /** Inject an instruction into our own agent's conversation. */
  | { type: 'nag_agent'; expectation: Expectation }
  /** Mention another bot in this thread — the only thing that wakes it. */
  | { type: 'ping_bot'; expectation: Expectation; name: string }
  /** Hand it to people: reminders exhausted, or the owner cannot answer. */
  | { type: 'escalate_human'; expectation: Expectation; reason: EscalationReason };

export type EscalationReason = 'reminders_exhausted' | 'owner_stalled' | 'unreachable';
