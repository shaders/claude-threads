/**
 * Review-chain reducer — the whole decision layer, pure.
 *
 * `tick()` takes the open expectations and a snapshot of the world and returns
 * the new expectations plus what to do. No clock, no session, no platform, no
 * model: every branch is reachable from a test with a literal, which is the only
 * reason a five-step cross-process chain is testable at all.
 *
 * The arming helpers live here too, because they are the same kind of function —
 * a pure edit of the ledger with a stable id, so arming the same step twice
 * cannot produce two of it.
 */

import {
  partyKey,
  type ChainAction,
  type ChainFacts,
  type ChainPolicy,
  type Expectation,
  type ExpectationKind,
  type Party,
} from './types.js';

/** Stable id for a step. Subject-less steps get one slot per session. */
export function expectationId(kind: ExpectationKind, subject?: string): string {
  return `${kind}:${subject ?? '-'}`;
}

/**
 * Add an expectation unless that exact step is already known.
 *
 * Returns the list unchanged when the step exists in ANY state — including
 * `satisfied` and `failed`. Re-arming a settled step is how a loop starts: the
 * MR url is re-observed on every turn, and a fresh `open` each time would nag
 * about a review that already happened.
 */
export function armExpectation(
  expectations: Expectation[],
  spec: {
    kind: ExpectationKind;
    owner: Party;
    waiter: Party;
    subject?: string;
    now: number;
  }
): Expectation[] {
  const id = expectationId(spec.kind, spec.subject);
  if (expectations.some((e) => e.id === id)) return expectations;
  return [
    ...expectations,
    {
      id,
      kind: spec.kind,
      owner: spec.owner,
      waiter: spec.waiter,
      subject: spec.subject,
      state: 'open',
      since: spec.now,
      reminders: 0,
    },
  ];
}

/** Settle a step from outside the tick (a delivery landed, a route dead-ended). */
export function settleExpectation(
  expectations: Expectation[],
  id: string,
  state: 'satisfied' | 'waived' | 'failed',
  resolution?: string
): Expectation[] {
  return expectations.map((e) =>
    e.id === id && e.state === 'open' ? { ...e, state, resolution } : e
  );
}

export function openExpectations(expectations: Expectation[]): Expectation[] {
  return expectations.filter((e) => e.state === 'open');
}

/**
 * How long the owner has been silent on this step.
 *
 * Measured from the LATEST of: when we started waiting, when the owner was last
 * seen in the thread, and when we last nudged them. The nudge has to count —
 * otherwise the first reminder is immediately followed by the second, third and
 * the cap, all within one tick of each other, and the owner never gets a chance
 * to answer.
 */
function silenceMs(expectation: Expectation, facts: ChainFacts): number {
  const seen = facts.lastSeen[partyKey(expectation.owner)] ?? 0;
  const baseline = Math.max(expectation.since, seen, expectation.lastNudgeAt ?? 0);
  return facts.now - baseline;
}

/**
 * Has the owner shown up on this step at all? Decides which silence window
 * applies: a bot that never woke is a different diagnosis from one that has been
 * posting and went quiet, and the two deserve very different patience.
 */
function ownerAppeared(expectation: Expectation, facts: ChainFacts): boolean {
  const seen = facts.lastSeen[partyKey(expectation.owner)] ?? 0;
  // Same-millisecond activity counts as having appeared — the generous reading,
  // which buys the owner the longer silence window rather than the short one.
  return seen >= expectation.since;
}

/**
 * Advance the chain. Returns the updated ledger and the actions to perform;
 * calling it twice with the same facts (and a `now` that has not moved past the
 * silence window) produces no second round of nudges.
 */
export function tick(
  expectations: Expectation[],
  facts: ChainFacts,
  policy: ChainPolicy
): { expectations: Expectation[]; actions: ChainAction[] } {
  const actions: ChainAction[] = [];

  const next = expectations.map((expectation): Expectation => {
    if (expectation.state !== 'open') return expectation;

    // 1. Deterministic satisfaction wins over everything else, including a
    //    reminder we would otherwise send in this same tick.
    if (facts.satisfiedIds.includes(expectation.id)) {
      return { ...expectation, state: 'satisfied' };
    }

    // 2. An owner who cannot answer is not reminded. Their bot said so in the
    //    thread ("hit a rate limit"), and pinging it until the cap just delays
    //    the only useful move by three intervals.
    if (facts.stalled.includes(partyKey(expectation.owner))) {
      actions.push({ type: 'escalate_human', expectation, reason: 'owner_stalled' });
      return { ...expectation, state: 'failed', resolution: 'owner cannot answer' };
    }

    // 3. Out of reminders — the humans get it, and we stop tracking. Checked
    //    before the readiness gates below so a capped step cannot linger open
    //    forever just because the moment to nudge never came round again.
    if (expectation.reminders >= policy.maxReminders) {
      actions.push({ type: 'escalate_human', expectation, reason: 'reminders_exhausted' });
      return { ...expectation, state: 'failed', resolution: 'no answer after reminders' };
    }

    if (expectation.owner.kind === 'agent') {
      // Our own agent: the moment to act is the end of a turn, not a deadline.
      // Mid-turn injection would land in the middle of work it is already doing.
      if (facts.selfProcessing || !facts.selfSettled) return expectation;
      // At most one nudge per completed turn, so repeated ticks inside the same
      // turn cannot walk the whole ladder to the escalation.
      if (expectation.lastNudgeTurn !== undefined && expectation.lastNudgeTurn >= facts.selfTurns) {
        return expectation;
      }
      actions.push({ type: 'nag_agent', expectation });
      return {
        ...expectation,
        reminders: expectation.reminders + 1,
        lastNudgeAt: facts.now,
        lastNudgeTurn: facts.selfTurns,
      };
    }

    // Someone else's process: we cannot see their turns, only their traffic in
    // this thread. Silence is the only evidence there is, so it is the trigger.
    const window = ownerAppeared(expectation, facts) ? policy.workSilenceMs : policy.awakeSilenceMs;
    if (silenceMs(expectation, facts) < window) return expectation;

    if (expectation.owner.kind === 'bot') {
      actions.push({ type: 'ping_bot', expectation, name: expectation.owner.name });
    } else {
      // A human owner is only ever escalated to — there is nothing else to do
      // with them, and a "reminder" and an "escalation" are the same @mention.
      actions.push({ type: 'escalate_human', expectation, reason: 'reminders_exhausted' });
    }
    return { ...expectation, reminders: expectation.reminders + 1, lastNudgeAt: facts.now };
  });

  return { expectations: next, actions };
}
