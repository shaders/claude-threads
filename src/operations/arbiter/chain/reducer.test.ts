/**
 * Tests for the review-chain reducer.
 *
 * The failure modes worth pinning are all about restraint, not about firing:
 * nudging a busy agent mid-turn, nudging a reviewer who is visibly working,
 * emitting the whole reminder ladder in one tick, and re-arming a step that
 * already settled. Each of those has been observed in this fleet in some form.
 */

import { describe, test, expect } from 'bun:test';
import { armExpectation, expectationId, settleExpectation, tick } from './reducer.js';
import { DEFAULT_CHAIN_POLICY, type ChainFacts, type Expectation } from './types.js';

const T0 = 1_800_000_000_000;
const MR = 'https://gitlab.corp.pushwoosh.com/g/p/-/merge_requests/7';

function facts(over: Partial<ChainFacts> = {}): ChainFacts {
  return {
    now: T0,
    satisfiedIds: [],
    lastSeen: {},
    stalled: [],
    selfSettled: true,
    selfProcessing: false,
    selfTurns: 1,
    ...over,
  };
}

function agentStep(over: Partial<Expectation> = {}): Expectation {
  return {
    id: expectationId('review_requested', MR),
    kind: 'review_requested',
    owner: { kind: 'agent' },
    waiter: { kind: 'bot', name: 'rocksteady' },
    subject: MR,
    state: 'open',
    since: T0 - 60_000,
    reminders: 0,
    ...over,
  };
}

function botStep(over: Partial<Expectation> = {}): Expectation {
  return {
    id: expectationId('review_reply', MR),
    kind: 'review_reply',
    owner: { kind: 'bot', name: 'rocksteady' },
    waiter: { kind: 'agent' },
    subject: MR,
    state: 'open',
    since: T0 - 60_000,
    reminders: 0,
    ...over,
  };
}

describe('armExpectation', () => {
  test('is idempotent per step', () => {
    const once = armExpectation([], { kind: 'review_reply', owner: { kind: 'bot', name: 'rocksteady' }, waiter: { kind: 'agent' }, subject: MR, now: T0 });
    const twice = armExpectation(once, { kind: 'review_reply', owner: { kind: 'bot', name: 'rocksteady' }, waiter: { kind: 'agent' }, subject: MR, now: T0 + 5000 });
    expect(twice).toHaveLength(1);
    expect(twice[0].since).toBe(T0);
  });

  test('does not re-arm a step that already settled', () => {
    // The MR url is re-observed on every turn. A fresh `open` each time is how a
    // bot ends up asked for a review it already got.
    const settled = settleExpectation(
      armExpectation([], { kind: 'review_requested', owner: { kind: 'agent' }, waiter: { kind: 'bot', name: 'rocksteady' }, subject: MR, now: T0 }),
      expectationId('review_requested', MR),
      'satisfied'
    );
    const again = armExpectation(settled, { kind: 'review_requested', owner: { kind: 'agent' }, waiter: { kind: 'bot', name: 'rocksteady' }, subject: MR, now: T0 + 60_000 });
    expect(again).toHaveLength(1);
    expect(again[0].state).toBe('satisfied');
  });

  test('separates steps by subject, so a second MR gets its own chain', () => {
    const first = armExpectation([], { kind: 'review_reply', owner: { kind: 'bot', name: 'rocksteady' }, waiter: { kind: 'agent' }, subject: MR, now: T0 });
    const second = armExpectation(first, { kind: 'review_reply', owner: { kind: 'bot', name: 'rocksteady' }, waiter: { kind: 'agent' }, subject: `${MR}9`, now: T0 });
    expect(second).toHaveLength(2);
  });
});

describe('tick — our own agent', () => {
  test('nudges only once a turn has ended and settled', () => {
    const mid = tick([agentStep()], facts({ selfProcessing: true }), DEFAULT_CHAIN_POLICY);
    expect(mid.actions).toEqual([]);
    expect(mid.expectations[0].reminders).toBe(0);

    const unsettled = tick([agentStep()], facts({ selfSettled: false }), DEFAULT_CHAIN_POLICY);
    expect(unsettled.actions).toEqual([]);

    const settled = tick([agentStep()], facts(), DEFAULT_CHAIN_POLICY);
    expect(settled.actions).toEqual([{ type: 'nag_agent', expectation: expect.objectContaining({ kind: 'review_requested' }) }]);
    expect(settled.expectations[0].reminders).toBe(1);
    expect(settled.expectations[0].lastNudgeAt).toBe(T0);
  });

  test('nudges at most once per completed turn', () => {
    const first = tick([agentStep()], facts(), DEFAULT_CHAIN_POLICY);
    expect(first.actions).toHaveLength(1);

    // Same turn, later tick (a silence timer fired for some other step): the
    // ladder must not run itself out while the agent is composing a reply.
    const sameTurn = tick(first.expectations, facts({ now: T0 + 60_000 }), DEFAULT_CHAIN_POLICY);
    expect(sameTurn.actions).toEqual([]);
    expect(sameTurn.expectations[0].reminders).toBe(1);

    // A new turn ended and the step is still open — now it may speak again.
    const nextTurn = tick(first.expectations, facts({ now: T0 + 90_000, selfTurns: 2 }), DEFAULT_CHAIN_POLICY);
    expect(nextTurn.actions).toHaveLength(1);
    expect(nextTurn.expectations[0].reminders).toBe(2);
  });
});

describe('tick — another bot', () => {
  test('stays quiet while the reviewer has not been silent long enough', () => {
    const result = tick([botStep({ since: T0 - 30_000 })], facts(), DEFAULT_CHAIN_POLICY);
    expect(result.actions).toEqual([]);
  });

  test('pings once the reviewer never showed up (short window)', () => {
    const result = tick([botStep({ since: T0 - 3 * 60_000 })], facts(), DEFAULT_CHAIN_POLICY);
    expect(result.actions).toEqual([
      { type: 'ping_bot', expectation: expect.objectContaining({ kind: 'review_reply' }), name: 'rocksteady' },
    ]);
  });

  test('is far more patient once the reviewer has shown up', () => {
    const seen = { 'bot:rocksteady': T0 - 3 * 60_000 };
    // 3 min of silence from a reviewer that IS working: past the awake window,
    // well inside the work window. Interrupting here is what makes the arbiter
    // an annoyance instead of a safety net.
    const working = tick([botStep({ since: T0 - 10 * 60_000 })], facts({ lastSeen: seen }), DEFAULT_CHAIN_POLICY);
    expect(working.actions).toEqual([]);

    const gone = tick(
      [botStep({ since: T0 - 20 * 60_000 })],
      facts({ lastSeen: { 'bot:rocksteady': T0 - 6 * 60_000 } }),
      DEFAULT_CHAIN_POLICY
    );
    expect(gone.actions).toHaveLength(1);
  });

  test('the nudge restarts the silence window', () => {
    const first = tick([botStep({ since: T0 - 3 * 60_000 })], facts(), DEFAULT_CHAIN_POLICY);
    expect(first.actions).toHaveLength(1);

    const soonAfter = tick(first.expectations, facts({ now: T0 + 60_000 }), DEFAULT_CHAIN_POLICY);
    expect(soonAfter.actions).toEqual([]);

    const later = tick(first.expectations, facts({ now: T0 + 6 * 60_000 }), DEFAULT_CHAIN_POLICY);
    expect(later.actions).toHaveLength(1);
  });

  test('escalates instead of pinging when the owner cannot answer', () => {
    const result = tick([botStep()], facts({ stalled: ['bot:rocksteady'] }), DEFAULT_CHAIN_POLICY);
    expect(result.actions).toEqual([
      { type: 'escalate_human', expectation: expect.objectContaining({ kind: 'review_reply' }), reason: 'owner_stalled' },
    ]);
    expect(result.expectations[0].state).toBe('failed');
  });

  test('hands over to humans when the reminders run out', () => {
    const capped = botStep({ reminders: DEFAULT_CHAIN_POLICY.maxReminders, since: T0 - 30 * 60_000 });
    const result = tick([capped], facts(), DEFAULT_CHAIN_POLICY);
    expect(result.actions).toEqual([
      { type: 'escalate_human', expectation: expect.objectContaining({ kind: 'review_reply' }), reason: 'reminders_exhausted' },
    ]);
    expect(result.expectations[0].state).toBe('failed');

    // And then it is done: a failed step never speaks again.
    const after = tick(result.expectations, facts({ now: T0 + 60 * 60_000 }), DEFAULT_CHAIN_POLICY);
    expect(after.actions).toEqual([]);
  });
});

describe('tick — satisfaction', () => {
  test('satisfaction beats a reminder that was otherwise due in the same tick', () => {
    const due = botStep({ since: T0 - 10 * 60_000 });
    const result = tick([due], facts({ satisfiedIds: [due.id] }), DEFAULT_CHAIN_POLICY);
    expect(result.actions).toEqual([]);
    expect(result.expectations[0].state).toBe('satisfied');
  });

  test('leaves settled steps untouched', () => {
    const done = botStep({ state: 'satisfied' });
    const failed = agentStep({ state: 'failed' });
    const result = tick([done, failed], facts({ now: T0 + 60 * 60_000 }), DEFAULT_CHAIN_POLICY);
    expect(result.actions).toEqual([]);
    expect(result.expectations).toEqual([done, failed]);
  });
});
