/**
 * Tests for the review chain's wiring: observations in, posts and injections out.
 *
 * The reducer is covered separately; what is checked here is that the real hooks
 * feed it the right facts — that a reviewer's own streaming output counts as
 * liveness, that an unreachable reviewer reaches a person instead of nobody, and
 * that a rate-limited teammate is not pinged three times first.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import {
  cancelChain,
  getChainState,
  noteDeliveredToWaiter,
  noteIncomingReviewRequest,
  noteReviewRequest,
  notePartySeen,
  onTurnComplete,
  runTick,
} from './handler.js';
import { openExpectations } from './reducer.js';
import type { Session } from '../../../session/types.js';
import type { SessionContext } from '../../session-context/index.js';
import { createArbiterState } from '../types.js';

const MR = 'https://gitlab.corp.pushwoosh.com/DevOps/ai/team/-/merge_requests/95';

interface Spies {
  posts: string[];
  toAgent: string[];
}

let spies: Spies;

function makeSession(over: Partial<Session> = {}): Session {
  return {
    sessionId: 'mm:thread-1',
    threadId: 'thread-1',
    platformId: 'mm',
    startedBy: 'maxk',
    lastActivityAt: new Date(),
    isProcessing: false,
    messageCount: 1,
    lifecycle: { state: 'active' } as unknown as Session['lifecycle'],
    arbiter: createArbiterState(),
    platform: {
      getBotName: () => 'bebop',
      getMcpConfig: () => ({ teammates: [{ name: 'rocksteady', channelId: 'c1' }], channelId: 'c0' }),
      createPost: mock(async (message: string) => {
        spies.posts.push(message);
        return { id: `p${spies.posts.length}`, message, userId: 'bot' };
      }),
      getFormatter: () => ({
        formatBold: (t: string) => `**${t}**`,
        formatItalic: (t: string) => `_${t}_`,
        formatCode: (t: string) => `\`${t}\``,
      }),
    } as unknown as Session['platform'],
    claude: {
      isRunning: () => true,
      sendMessage: mock((msg: string) => { spies.toAgent.push(msg); }),
    } as unknown as Session['claude'],
    messageManager: {
      getPendingApproval: () => null,
      hasPendingQuestions: () => false,
      getPendingContextPrompt: () => null,
      getPendingMessageApproval: () => null,
      getPendingBugReport: () => null,
    } as unknown as Session['messageManager'],
    ...over,
  } as unknown as Session;
}

function makeCtx(session: Session, over: Record<string, unknown> = {}): SessionContext {
  return {
    config: { arbiterEnabled: true, reviewPing: { enabled: true, botName: 'rocksteady', channelId: 'c1' }, ...over },
    state: { sessions: new Map([[session.sessionId, session]]) },
    ops: { persistSession: mock(() => {}), startTyping: mock(() => {}) },
  } as unknown as SessionContext;
}

/**
 * Let the fire-and-forget action chain settle. Actions are dispatched with `void`
 * on purpose (a reminder must never block event handling), so a test has to give
 * the microtask queue a turn before asserting on posts.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Push an expectation's clock into the past so a silence window has elapsed. */
function ageExpectations(session: Session, ms: number): void {
  const state = getChainState(session);
  state.expectations = state.expectations.map((e) => ({
    ...e,
    since: e.since - ms,
    lastNudgeAt: e.lastNudgeAt ? e.lastNudgeAt - ms : undefined,
  }));
}

beforeEach(() => {
  spies = { posts: [], toAgent: [] };
});

describe('review request outcomes', () => {
  test('a delivered request moves the wait onto the reviewer', () => {
    const session = makeSession();
    const ctx = makeCtx(session);

    noteReviewRequest(session, ctx, MR, 'delivered');

    const open = openExpectations(getChainState(session).expectations);
    expect(open.map((e) => e.kind)).toEqual(['review_reply']);
    expect(open[0].owner).toEqual({ kind: 'bot', name: 'rocksteady' });
    cancelChain(session);
  });

  test('an unreachable reviewer goes straight to a person', async () => {
    const session = makeSession();
    const ctx = makeCtx(session);

    noteReviewRequest(session, ctx, MR, 'unreachable');
    await flush();

    // The case review-ping used to swallow: nobody can be asked, so the only
    // party left who can act is a human.
    expect(spies.posts.join('\n')).toContain('@maxk');
    expect(spies.posts.join('\n')).toContain('недостижим');
    expect(openExpectations(getChainState(session).expectations)).toEqual([]);
    cancelChain(session);
  });
});

describe('liveness from thread traffic', () => {
  test("the reviewer's own output closes the wait for a reply", () => {
    const session = makeSession();
    const ctx = makeCtx(session);
    noteReviewRequest(session, ctx, MR, 'delivered');

    notePartySeen(session, ctx, 'rocksteady', 'смотрю MR, пара вопросов по transformer.ts');

    expect(openExpectations(getChainState(session).expectations)).toEqual([]);
    expect(spies.posts).toEqual([]);
    cancelChain(session);
  });

  test('a silent reviewer is pinged in this thread, not somewhere else', async () => {
    const session = makeSession();
    const ctx = makeCtx(session);
    noteReviewRequest(session, ctx, MR, 'delivered');
    ageExpectations(session, 3 * 60_000);

    runTick(session, ctx);
    await flush();

    expect(spies.posts).toHaveLength(1);
    expect(spies.posts[0]).toContain('@rocksteady');
    expect(spies.posts[0]).toContain(MR);
    cancelChain(session);
  });

  test('a reviewer who announced a rate limit is escalated, never pinged', async () => {
    const session = makeSession();
    const ctx = makeCtx(session);
    noteReviewRequest(session, ctx, MR, 'delivered');

    // Their bot posts this itself when its account runs out (session/lifecycle.ts).
    notePartySeen(session, ctx, 'rocksteady', '⚠️ Claude account `rocksteady2` hit a rate limit. New sessions will use another account.');
    ageExpectations(session, 3 * 60_000);
    runTick(session, ctx);
    await flush();

    const posted = spies.posts.join('\n');
    expect(posted).toContain('@maxk');
    expect(posted).toContain('лимит');
    expect(posted).not.toContain('@rocksteady жду ревью');
    cancelChain(session);
  });
});

describe('the reviewer side', () => {
  test('a teammate asking for a review puts us on the hook for the answer', () => {
    const session = makeSession();
    const ctx = makeCtx(session);

    noteIncomingReviewRequest(session, ctx, `@bebop прошу ревью: ${MR}`, 'rocksteady');

    const open = openExpectations(getChainState(session).expectations);
    expect(open).toHaveLength(1);
    expect(open[0].kind).toBe('review_handback');
    expect(open[0].owner).toEqual({ kind: 'agent' });
    expect(open[0].waiter).toEqual({ kind: 'bot', name: 'rocksteady' });
    cancelChain(session);
  });

  test('a human asking for a review is ordinary work, not a chain', () => {
    const session = makeSession();
    const ctx = makeCtx(session);

    noteIncomingReviewRequest(session, ctx, `посмотри ревью ${MR}`, 'maxk');

    expect(getChainState(session).expectations).toEqual([]);
  });

  test('the hand-back closes it, however it was delivered', () => {
    const session = makeSession();
    const ctx = makeCtx(session);
    noteIncomingReviewRequest(session, ctx, `@bebop прошу ревью: ${MR}`, 'rocksteady');

    // The bot delivers on the agent's behalf — the requester heard it either way.
    noteDeliveredToWaiter(session, ctx, 'rocksteady');

    expect(openExpectations(getChainState(session).expectations)).toEqual([]);
    cancelChain(session);
  });

  test('a forgotten hand-back is an instruction to our own agent, not a ping', async () => {
    const session = makeSession();
    const ctx = makeCtx(session);
    noteIncomingReviewRequest(session, ctx, `@bebop прошу ревью: ${MR}`, 'rocksteady');

    // A turn ended and the settle window has passed.
    onTurnComplete(session, ctx);
    const state = getChainState(session);
    state.lastResultAt = Date.now() - 120_000;
    runTick(session, ctx);
    await flush();

    expect(spies.toAgent).toHaveLength(1);
    expect(spies.toAgent[0]).toContain('[Arbiter]');
    expect(spies.toAgent[0]).toContain('@rocksteady');
    expect(spies.posts).toEqual([]);
    cancelChain(session);
  });
});

describe('gates', () => {
  test('does nothing at all when the arbiter is off', () => {
    const session = makeSession();
    const ctx = makeCtx(session, { arbiterEnabled: false });

    noteReviewRequest(session, ctx, MR, 'delivered');
    noteIncomingReviewRequest(session, ctx, `@bebop прошу ревью: ${MR}`, 'rocksteady');
    notePartySeen(session, ctx, 'rocksteady', 'anything');

    expect(getChainState(session).expectations).toEqual([]);
    expect(spies.posts).toEqual([]);
  });

  test('an MR with no configured reviewer arms nothing', () => {
    const session = makeSession();
    const ctx = makeCtx(session, { reviewPing: undefined });
    session.pullRequestUrl = MR;

    onTurnComplete(session, ctx);

    expect(getChainState(session).expectations).toEqual([]);
    cancelChain(session);
  });

  test('an MR with a reviewer configured owes a review request from the turn it appears', () => {
    const session = makeSession();
    const ctx = makeCtx(session);
    session.pullRequestUrl = MR;

    onTurnComplete(session, ctx);

    const open = openExpectations(getChainState(session).expectations);
    expect(open.map((e) => e.kind)).toEqual(['review_requested']);
    cancelChain(session);
  });
});
