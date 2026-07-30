/**
 * Tests for the chain's clock — the part `handler.test.ts` could not reach.
 *
 * Those tests drive `runTick` directly against a prepared state, so they never
 * exercise the interaction between `ensureTimer` and `runCycle`. That gap hid the
 * bug this file exists for: the reviewer's first post satisfies `review_reply`,
 * which used to leave no open foreign-owned step, so the interval was cleared —
 * and the two things only a tick performs (judging the finished review, asking
 * GitLab about the approval) never ran again. The main scenario of the whole
 * feature silently did nothing.
 *
 * `verify.js` is mocked at module level: the real thing spawns `glab` and calls a
 * model, neither of which belongs in a unit test.
 */

import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';

const verifyCfg: { approved: boolean | null; verdict: 'clean' | 'fixes' | null } = {
  approved: null,
  verdict: null,
};
const checkMrApprovedMock = mock(async (_url: string) => verifyCfg.approved);
const classifyReviewVerdictMock = mock(async (_text: string) => verifyCfg.verdict);

const realVerify = await import('./verify.js');
mock.module('./verify.js', () => ({
  ...realVerify,
  checkMrApproved: checkMrApprovedMock,
  classifyReviewVerdict: classifyReviewVerdictMock,
}));

afterAll(() => {
  mock.module('./verify.js', () => realVerify);
});

const {
  cancelChain,
  getChainState,
  hasClockWork,
  noteReviewRequest,
  notePartySeen,
  resolveChainPolicy,
  runTick,
} = await import('./handler.js');
const { openExpectations } = await import('./reducer.js');
const { createChainState } = await import('./state.js');
const { createArbiterState } = await import('../types.js');

import type { Session } from '../../../session/types.js';
import type { SessionContext } from '../../session-context/index.js';

const MR = 'https://gitlab.corp.pushwoosh.com/DevOps/ai/team/-/merge_requests/95';

let posts: string[];

function makeSession(): Session {
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
        posts.push(message);
        return { id: `p${posts.length}`, message, userId: 'bot' };
      }),
      getFormatter: () => ({
        formatBold: (t: string) => `**${t}**`,
        formatItalic: (t: string) => `_${t}_`,
        formatCode: (t: string) => `\`${t}\``,
      }),
    } as unknown as Session['platform'],
    claude: { isRunning: () => true, sendMessage: mock(() => {}) } as unknown as Session['claude'],
    messageManager: {
      getPendingApproval: () => null,
      hasPendingQuestions: () => false,
      getPendingContextPrompt: () => null,
      getPendingMessageApproval: () => null,
      getPendingBugReport: () => null,
    } as unknown as Session['messageManager'],
  } as unknown as Session;
}

function makeCtx(session: Session): SessionContext {
  return {
    config: { arbiterEnabled: true, reviewPing: { enabled: true, botName: 'rocksteady', channelId: 'c1' } },
    state: { sessions: new Map([[session.sessionId, session]]) },
    ops: { persistSession: mock(() => {}), startTyping: mock(() => {}) },
  } as unknown as SessionContext;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  posts = [];
  verifyCfg.approved = null;
  verifyCfg.verdict = null;
  checkMrApprovedMock.mockClear();
  classifyReviewVerdictMock.mockClear();
});

describe('the clock survives the reviewer answering', () => {
  test('work remains once review_reply is satisfied but unjudged', async () => {
    const session = makeSession();
    const ctx = makeCtx(session);
    noteReviewRequest(session, ctx, MR, 'delivered');

    notePartySeen(session, ctx, 'rocksteady', 'смотрю MR, минут десять');
    await flush();

    const state = getChainState(session);
    // Nothing is open any more — and that used to be the end of the chain.
    expect(openExpectations(state.expectations)).toEqual([]);
    expect(hasClockWork(state)).toBe(true);
    expect(state.timer).toBeDefined();
    cancelChain(session);
  });

  test('a clean review that goes quiet becomes an approval we wait for', async () => {
    const session = makeSession();
    const ctx = makeCtx(session);
    noteReviewRequest(session, ctx, MR, 'delivered');

    notePartySeen(session, ctx, 'rocksteady', 'посмотрел, всё чисто, вопросов нет');
    await flush();

    // The reviewer has now been quiet longer than the work window.
    const state = getChainState(session);
    state.lastSeen['bot:rocksteady'] = Date.now() - 10 * 60_000;
    verifyCfg.verdict = 'clean';

    runTick(session, ctx); // the tick alone must not decide anything fuzzy
    expect(classifyReviewVerdictMock).not.toHaveBeenCalled();

    const { runCycle } = await import('./handler.js');
    runCycle(session, ctx);
    await flush();

    expect(classifyReviewVerdictMock).toHaveBeenCalled();
    expect(state.verdicts[MR]).toBe('clean');
    const open = openExpectations(state.expectations);
    expect(open.map((e) => e.kind)).toEqual(['mr_approved']);
    expect(open[0].owner).toEqual({ kind: 'bot', name: 'rocksteady' });
    cancelChain(session);
  });

  test('a review that asked for changes never waits for an approval', async () => {
    const session = makeSession();
    const ctx = makeCtx(session);
    noteReviewRequest(session, ctx, MR, 'delivered');
    notePartySeen(session, ctx, 'rocksteady', 'тут падает на пустом списке, поправь');
    await flush();

    const state = getChainState(session);
    state.lastSeen['bot:rocksteady'] = Date.now() - 10 * 60_000;
    verifyCfg.verdict = 'fixes';

    const { runCycle } = await import('./handler.js');
    runCycle(session, ctx);
    await flush();

    expect(state.verdicts[MR]).toBe('fixes');
    // Demanding an approval here would be asking for a rubber stamp on an MR the
    // reviewer just rejected.
    expect(state.expectations.some((e) => e.kind === 'mr_approved')).toBe(false);
    expect(hasClockWork(state)).toBe(false);
    cancelChain(session);
  });

  test('an approval closes the step and tells the human who asked', async () => {
    const session = makeSession();
    const ctx = makeCtx(session);
    noteReviewRequest(session, ctx, MR, 'delivered');
    notePartySeen(session, ctx, 'rocksteady', 'всё чисто');
    await flush();

    const state = getChainState(session);
    state.lastSeen['bot:rocksteady'] = Date.now() - 10 * 60_000;
    verifyCfg.verdict = 'clean';
    verifyCfg.approved = true;

    const { runCycle } = await import('./handler.js');
    runCycle(session, ctx);
    await flush();
    await flush();

    expect(checkMrApprovedMock).toHaveBeenCalledWith(MR);
    expect(openExpectations(state.expectations)).toEqual([]);
    expect(posts.join('\n')).toContain('@maxk');
    expect(posts.join('\n')).toContain('готово');
    cancelChain(session);
  });

  test('an unknown approval answer changes nothing', async () => {
    const session = makeSession();
    const ctx = makeCtx(session);
    noteReviewRequest(session, ctx, MR, 'delivered');
    notePartySeen(session, ctx, 'rocksteady', 'чисто');
    await flush();

    const state = getChainState(session);
    state.lastSeen['bot:rocksteady'] = Date.now() - 10 * 60_000;
    verifyCfg.verdict = 'clean';
    verifyCfg.approved = null; // glab unreachable, token expired, no approvals API

    const { runCycle } = await import('./handler.js');
    runCycle(session, ctx);
    await flush();

    // Still waiting — and crucially not reported to the human as done.
    expect(openExpectations(state.expectations).map((e) => e.kind)).toEqual(['mr_approved']);
    expect(posts.join('\n')).not.toContain('готово');
    cancelChain(session);
  });
});

describe('a restart does not blame the reviewer for our downtime', () => {
  test('silence is measured from the new process, not from the old ledger', async () => {
    const session = makeSession();
    const ctx = makeCtx(session);
    noteReviewRequest(session, ctx, MR, 'delivered');

    // Simulate a restart: the ledger is restored from disk with its original
    // stamps, everything else starts empty — which is what createChainState does.
    const persisted = { expectations: getChainState(session).expectations };
    cancelChain(session);
    session.arbiter!.chain = createChainState(persisted);
    const state = getChainState(session);
    state.expectations = state.expectations.map((e) => ({ ...e, since: Date.now() - 6 * 60 * 60_000 }));

    runTick(session, ctx);
    await flush();

    // Six hours of "silence", all of it ours. The reviewer hears nothing about it.
    expect(posts).toEqual([]);
    expect(openExpectations(state.expectations).map((e) => e.kind)).toEqual(['review_reply']);
    cancelChain(session);
  });
});

describe('resolveChainPolicy', () => {
  test('refuses a work window shorter than the awake window', () => {
    const warnings: string[] = [];
    const policy = resolveChainPolicy(
      { awakeSilenceMs: 120_000, workSilenceMs: 30_000 },
      (m) => warnings.push(m)
    );
    // Inverted windows turn the design upside down: a reviewer who IS working
    // would be interrupted sooner than one who never woke up.
    expect(policy.workSilenceMs).toBe(120_000);
    expect(warnings.join(' ')).toContain('workSilenceMs');
  });

  test('rejects nonsense numbers instead of acting on them', () => {
    const warnings: string[] = [];
    const policy = resolveChainPolicy(
      { awakeSilenceMs: 0, workSilenceMs: -5, maxReminders: 0 },
      (m) => warnings.push(m)
    );
    expect(policy.awakeSilenceMs).toBeGreaterThan(0);
    expect(policy.workSilenceMs).toBeGreaterThan(0);
    expect(policy.maxReminders).toBe(1);
    expect(warnings).toHaveLength(3);
  });

  test('leaves a sane config alone', () => {
    expect(resolveChainPolicy({ awakeSilenceMs: 60_000, workSilenceMs: 600_000, maxReminders: 3 }))
      .toEqual({ awakeSilenceMs: 60_000, workSilenceMs: 600_000, maxReminders: 3 });
  });
});

describe('who counts as a bot', () => {
  test('the configured reviewer counts even when missing from teammates', async () => {
    const { partyForUser } = await import('./handler.js');
    const session = makeSession();
    session.platform.getMcpConfig = (() => ({ teammates: [], channelId: 'c0' })) as never;
    const ctx = makeCtx(session);

    // The two names live in different config blocks; a mismatch used to file the
    // reviewer's own reply as a human's, so `review_reply` never matched it.
    expect(partyForUser(session, ctx, 'rocksteady')).toEqual({ kind: 'bot', name: 'rocksteady' });
    expect(partyForUser(session, ctx, 'maxk')).toEqual({ kind: 'human', name: 'maxk' });
  });
});
