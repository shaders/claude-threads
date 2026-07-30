/**
 * Review chain — the impure half: facts in, actions out.
 *
 * Everything decided here is decided by `reducer.tick()`. This module only
 * gathers what is observable and performs what was decided, so the interesting
 * logic stays testable without a platform:
 *
 *   observations                    →  facts  →  tick()  →  actions  →  side effects
 *   ─────────────────────────────      ─────     ──────     ───────     ────────────
 *   posts/edits by other parties       lastSeen            nag_agent    sendMessage
 *   our own `result` events            turns               ping_bot     post in thread
 *   review-ping delivery/failure       satisfiedIds        escalate     @mention people
 *   a teammate's rate-limit notice     stalled
 *
 * Timers exist for one purpose: a foreign owner's silence cannot arrive as an
 * event, so it has to be looked at on a schedule. Our own agent's steps are
 * driven by turn ends, never by the clock.
 */

import { createLogger } from '../../../utils/logger.js';
import { createSessionLog } from '../../../utils/session-log.js';
import { post } from '../../post-helpers/index.js';
import { extractPullRequestUrl } from '../../../utils/pr-detector.js';
import { canIntervene } from '../handler.js';
import type { Session } from '../../../session/types.js';
import type { SessionContext } from '../../session-context/index.js';
import type { ArbiterChainConfig } from '../../../config/index.js';
import { agentNudge, botPing, humanEscalation, stepDescription } from './messages.js';
import { armExpectation, expectationId, openExpectations, settleExpectation, tick } from './reducer.js';
import { createChainState, type ChainSessionState } from './state.js';
import { APPROVAL_CACHE_MS, checkMrApproved, classifyReviewVerdict } from './verify.js';
import {
  DEFAULT_CHAIN_POLICY,
  partyKey,
  type ChainAction,
  type ChainFacts,
  type ChainPolicy,
  type Expectation,
  type Party,
} from './types.js';

const log = createLogger('arb-chain');
const sessionLog = createSessionLog(log);

/**
 * Quiet time after a turn ends before an agent-owned step may speak. Matches the
 * return-delivery window: long enough that a multi-turn stretch of work (agent
 * → arbiter nudge → agent) is treated as one piece of work rather than three.
 */
export const SETTLE_MS = 90_000;

/** How often a foreign owner's silence is re-examined while any step is open. */
export const SILENCE_TICK_MS = 60_000;

/** Posts kept per party, and the cap per post, for the verdict classification. */
const MAX_PARTY_POSTS = 12;
const MAX_POST_CHARS = 1500;

/** Everything we still remember a party saying, oldest first. */
function partyTranscript(state: ChainSessionState, key: string): string {
  return (state.partyPosts[key] ?? []).join('\n\n').trim();
}

/**
 * Our own bot's rate-limit notice, as it appears in a thread. Matched here
 * rather than through `detectRateLimit` on purpose: that list feeds account
 * cooldown, where a loose match costs real capacity, so it stays narrow. This
 * matches one string we write ourselves (session/lifecycle.ts), which makes it
 * both precise and ours to keep in sync.
 */
const RATE_LIMIT_NOTICE = /claude account.*hit a rate limit/i;

export function getChainState(session: Session): ChainSessionState {
  const arbiter = session.arbiter;
  if (!arbiter) return createChainState();
  if (!arbiter.chain) arbiter.chain = createChainState();
  return arbiter.chain;
}

function enabled(ctx: SessionContext): boolean {
  if (ctx.config.arbiterEnabled === false) return false;
  return ctx.config.arbiterChain?.enabled !== false;
}

/**
 * Resolve the policy, refusing to act on a configuration that cannot mean what it
 * says. Clamped rather than thrown: a typo in one number must not stop a fleet
 * host from booting, and the log line says exactly what was ignored.
 *
 * `workSilenceMs < awakeSilenceMs` is the one that matters — it inverts the whole
 * design, making a reviewer who IS working get interrupted sooner than one who
 * never woke up.
 */
export function resolveChainPolicy(config: ArbiterChainConfig | undefined, warn?: (msg: string) => void): ChainPolicy {
  const p = config ?? {};
  const awakeSilenceMs = positive(p.awakeSilenceMs, DEFAULT_CHAIN_POLICY.awakeSilenceMs, 'awakeSilenceMs', warn);
  let workSilenceMs = positive(p.workSilenceMs, DEFAULT_CHAIN_POLICY.workSilenceMs, 'workSilenceMs', warn);
  if (workSilenceMs < awakeSilenceMs) {
    warn?.(`arbiterChain.workSilenceMs (${workSilenceMs}) is below awakeSilenceMs (${awakeSilenceMs}) — raising it to match`);
    workSilenceMs = awakeSilenceMs;
  }
  let maxReminders = Math.round(p.maxReminders ?? DEFAULT_CHAIN_POLICY.maxReminders);
  if (!Number.isFinite(maxReminders) || maxReminders < 1) {
    warn?.(`arbiterChain.maxReminders (${p.maxReminders}) must be at least 1 — using 1`);
    maxReminders = 1;
  }
  return { awakeSilenceMs, workSilenceMs, maxReminders };
}

function positive(value: number | undefined, fallback: number, field: string, warn?: (msg: string) => void): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    warn?.(`arbiterChain.${field} (${value}) must be a positive number — using ${fallback}`);
    return fallback;
  }
  return value;
}

function policy(ctx: SessionContext): ChainPolicy {
  return resolveChainPolicy(ctx.config.arbiterChain, (msg) => log.warn(msg));
}

/** The reviewer this fleet uses, from the review-ping config. */
export function reviewerName(ctx: SessionContext): string | undefined {
  const name = ctx.config.reviewPing?.botName?.trim();
  return name || undefined;
}

/** Are we the reviewer ourselves? Then the requester-side steps are not ours. */
function isReviewerSelf(session: Session, ctx: SessionContext): boolean {
  const reviewer = reviewerName(ctx);
  const own = session.platform.getBotName?.();
  return Boolean(reviewer && own && reviewer.toLowerCase() === own.toLowerCase());
}

/**
 * Classify a username: a known teammate is a bot, anyone else is a person.
 *
 * The configured reviewer counts as a bot even when absent from `teammates`.
 * Those two lists come from different config blocks (`reviewPing.botName` vs
 * `teammates[].name`), and a typo in either used to mean the reviewer's own reply
 * was filed as a human's — so `review_reply` never matched it and the chain went
 * on pinging somebody who had already answered.
 */
export function partyForUser(session: Session, ctx: SessionContext, username: string): Party {
  const teammates = session.platform.getMcpConfig?.().teammates ?? [];
  const names = [...teammates.map((t) => t.name), reviewerName(ctx) ?? ''];
  const isBot = names.some((n) => n && n.toLowerCase() === username.toLowerCase());
  return isBot ? { kind: 'bot', name: username } : { kind: 'human', name: username };
}

function persistIfActive(session: Session, ctx: SessionContext): void {
  if (!ctx.state.sessions.has(session.sessionId)) return;
  ctx.ops.persistSession(session);
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/**
 * Somebody other than us said something in this thread.
 *
 * The single liveness signal for a foreign owner, and the reason a reviewer that
 * is visibly working is never interrupted. Called for EVERY post in the thread,
 * including the ones quiet mode refuses to route to the agent — those are
 * exactly a teammate's own streaming output, which is the traffic we need.
 */
export function notePartySeen(
  session: Session,
  ctx: SessionContext,
  username: string,
  text: string
): void {
  if (!enabled(ctx) || !username || username === 'unknown') return;
  const state = getChainState(session);
  const key = partyKey(partyForUser(session, ctx, username));

  // A rate-limit notice is the one post from a party that is NOT a sign of life —
  // it is their bot saying nobody is coming. Counting it as activity would close
  // "the reviewer replied" on the very evidence that they cannot, and the step
  // would settle as done while the review never happens.
  if (RATE_LIMIT_NOTICE.test(text)) {
    if (!state.stalled.includes(key)) {
      state.stalled.push(key);
      sessionLog(session).info(`⛓️ ${key} announced a rate limit — escalating instead of pinging`);
    }
    runTick(session, ctx);
    return;
  }

  state.lastSeen[key] = Date.now();
  // They are talking again, so whatever blocked them earlier has passed. Without
  // this a teammate is written off for the rest of the session by one bad hour.
  state.stalled = state.stalled.filter((k) => k !== key);

  // Keep the last few things they said: a review's verdict, its findings and its
  // file list arrive as separate posts, and classifying only the last one reads a
  // list of file names as a conclusion.
  if (text.trim()) {
    const posts = [...(state.partyPosts[key] ?? []), text.slice(0, MAX_POST_CHARS)];
    state.partyPosts[key] = posts.slice(-MAX_PARTY_POSTS);
  }

  // The full cycle, not just the tick: their arrival can be the moment an
  // approval becomes checkable, and a tick alone cannot ask GitLab anything.
  runCycle(session, ctx);
}

/**
 * A teammate asked US for a review. We are the reviewer in this thread now, and
 * we owe them an answer that reaches them — their session sleeps until mentioned,
 * so finishing the review silently leaves them blocked forever.
 */
export function noteIncomingReviewRequest(
  session: Session,
  ctx: SessionContext,
  message: string,
  username: string | undefined
): void {
  if (!enabled(ctx) || !username) return;
  const requester = partyForUser(session, ctx, username);
  if (requester.kind !== 'bot') return; // a human asking is the ordinary case, not a chain
  const mrUrl = extractPullRequestUrl(message);
  if (!mrUrl) return;
  if (!/ревью|review|апрув|approve/i.test(message)) return;

  const state = getChainState(session);
  const before = state.expectations.length;
  state.expectations = armExpectation(state.expectations, {
    kind: 'review_handback',
    owner: { kind: 'agent' },
    waiter: requester,
    subject: mrUrl,
    now: Date.now(),
  });
  if (state.expectations.length !== before) {
    sessionLog(session).info(`⛓️ Owe @${username} the result of the review on ${mrUrl}`);
    persistIfActive(session, ctx);
  }
}

/**
 * Outcome of the review request, reported by review-ping.
 *
 * `delivered` closes the step our agent owed. `unreachable` fails it outright and
 * goes to the humans: the reviewer holds no session in this channel, so neither a
 * reminder to the agent nor a mention has anywhere to land — the case review-ping
 * used to swallow silently.
 */
export function noteReviewRequest(
  session: Session,
  ctx: SessionContext,
  mrUrl: string,
  outcome: 'delivered' | 'unreachable'
): void {
  if (!enabled(ctx)) return;
  const reviewer = reviewerName(ctx);
  if (!reviewer) return;

  const state = getChainState(session);
  const now = Date.now();
  const id = expectationId('review_requested', mrUrl);
  state.expectations = armExpectation(state.expectations, {
    kind: 'review_requested',
    owner: { kind: 'agent' },
    waiter: { kind: 'bot', name: reviewer },
    subject: mrUrl,
    now,
  });

  if (outcome === 'delivered') {
    state.expectations = settleExpectation(state.expectations, id, 'satisfied', 'review requested');
    state.expectations = armExpectation(state.expectations, {
      kind: 'review_reply',
      owner: { kind: 'bot', name: reviewer },
      waiter: { kind: 'agent' },
      subject: mrUrl,
      now,
    });
    sessionLog(session).info(`⛓️ Waiting for @${reviewer} on ${mrUrl}`);
  } else {
    // Escalate only on the transition. review-ping marks an MR as pinged before
    // it reports, so a double call should not be possible — but "should not" is
    // not a guarantee, and the cost of being wrong is a second @mention of a
    // person about a chain they were already told about.
    const wasOpen = state.expectations.some((e) => e.id === id && e.state === 'open');
    state.expectations = settleExpectation(state.expectations, id, 'failed', 'reviewer unreachable');
    const target = state.expectations.find((e) => e.id === id);
    if (wasOpen && target) {
      void execute(session, ctx, { type: 'escalate_human', expectation: target, reason: 'unreachable' });
    }
  }

  persistIfActive(session, ctx);
  ensureTimer(session, ctx);
}

/**
 * The bot delivered something to a waiting party on the agent's behalf (the
 * teammate hand-back, the return delivery). Whatever we owed that party is met —
 * the agent not having made the call itself is irrelevant to whether they heard.
 */
export function noteDeliveredToWaiter(session: Session, ctx: SessionContext, waiter: string): void {
  if (!enabled(ctx)) return;
  const state = getChainState(session);
  const key = partyKey(partyForUser(session, ctx, waiter));
  let changed = false;
  for (const expectation of openExpectations(state.expectations)) {
    if (partyKey(expectation.waiter) !== key) continue;
    if (expectation.kind !== 'review_handback' && expectation.kind !== 'task_report') continue;
    state.expectations = settleExpectation(state.expectations, expectation.id, 'satisfied', 'delivered by the bot');
    changed = true;
    sessionLog(session).info(`⛓️ ${stepDescription(expectation)} — closed by the bot's own delivery`);
  }
  if (changed) persistIfActive(session, ctx);
}

/** A turn ended: bump the turn clock and give agent-owned steps their moment. */
export function onTurnComplete(session: Session, ctx: SessionContext): void {
  if (!enabled(ctx)) return;
  const state = getChainState(session);
  state.turns++;
  state.lastResultAt = Date.now();

  // An MR with no review chain yet — the step exists from the moment the MR does,
  // so a review-ping that never fires is still a step somebody owes.
  const mrUrl = session.pullRequestUrl;
  const reviewer = reviewerName(ctx);
  if (mrUrl && reviewer && !isReviewerSelf(session, ctx)) {
    state.expectations = armExpectation(state.expectations, {
      kind: 'review_requested',
      owner: { kind: 'agent' },
      waiter: { kind: 'bot', name: reviewer },
      subject: mrUrl,
      now: Date.now(),
    });
  }

  if (state.settleTimer) clearTimeout(state.settleTimer);
  state.settleTimer = setTimeout(() => {
    state.settleTimer = undefined;
    runCycle(session, ctx);
  }, SETTLE_MS);
  state.settleTimer.unref?.();

  ensureTimer(session, ctx);
}

/** Drop every timer. Call when the session ends, is killed, or restarts. */
export function cancelChain(session: Session): void {
  const state = session.arbiter?.chain;
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  if (state.settleTimer) clearTimeout(state.settleTimer);
  state.timer = undefined;
  state.settleTimer = undefined;
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

/**
 * Is there anything a tick could still advance?
 *
 * This is deliberately broader than "an open step owned by somebody else", and
 * getting that wrong killed the chain's main scenario: `review_reply` is
 * satisfied by the reviewer's FIRST post ("смотрю MR"), which used to leave no
 * open foreign step at all — so the interval was cleared while the two pieces of
 * work that only a tick performs were still pending. Both live in `runCycle`:
 * classifying the review once the reviewer goes quiet, and asking GitLab whether
 * the approval appeared. The reviewer then read the diff for ten minutes, nobody
 * ticked, no approval was ever checked, and the human was never told.
 */
export function hasClockWork(state: ChainSessionState): boolean {
  const open = openExpectations(state.expectations);

  // Someone else's silence has to be watched.
  if (open.some((e) => e.owner.kind !== 'agent')) return true;
  // An approval we are waiting for is only ever observed by polling GitLab —
  // including when the owner is our own agent (we are the reviewer).
  if (open.some((e) => e.kind === 'mr_approved')) return true;
  // A reply that landed but has not been judged yet: the verdict decides whether
  // an approval is owed, and it is judged from silence, which needs a clock.
  if (state.expectations.some((e) =>
    e.kind === 'review_reply' && e.state === 'satisfied' && e.subject && !state.verdicts[e.subject]
  )) return true;
  // Our own review, not yet judged. Also the retry path for a classification that
  // timed out — otherwise one hung haiku call loses the self-check forever.
  if (open.some((e) => e.kind === 'review_handback' && e.subject && !state.verdicts[e.subject])) return true;

  return false;
}

/**
 * Only run the clock while something is actually pending. An always-on interval
 * per session would be a timer per thread doing nothing for hours, on a host
 * where one runaway process has already taken the fleet down.
 */
function ensureTimer(session: Session, ctx: SessionContext): void {
  const state = getChainState(session);

  if (!hasClockWork(state)) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    return;
  }
  if (state.timer) return;

  state.timer = setInterval(() => runCycle(session, ctx), SILENCE_TICK_MS) as unknown as ReturnType<typeof setTimeout>;
  (state.timer as unknown as { unref?: () => void }).unref?.();
}

/** Facts as they are right now. Pure given the session — no decisions taken. */
export function buildFacts(session: Session): ChainFacts {
  const state = getChainState(session);
  const now = Date.now();

  // A reviewer who has spoken in this thread since we started waiting HAS
  // replied; that is the whole content of `review_reply`, so it is satisfied
  // from the same silence bookkeeping rather than by a separate observation.
  const satisfiedIds = openExpectations(state.expectations)
    // `>=`, not `>`: arming and the reply can land in the same millisecond when a
    // teammate is already mid-answer, and a chain that then waits for a reply it
    // already has goes on to ping the reviewer for work they are doing.
    .filter((e) => e.kind === 'review_reply' && (state.lastSeen[partyKey(e.owner)] ?? 0) >= e.since)
    .map((e) => e.id);

  return {
    now,
    satisfiedIds,
    lastSeen: state.lastSeen,
    stalled: state.stalled,
    selfProcessing: session.isProcessing,
    selfSettled: Boolean(state.lastResultAt) && now - (state.lastResultAt ?? 0) >= SETTLE_MS,
    selfTurns: state.turns,
    clockBaseAt: state.clockBaseAt,
  };
}

/**
 * One full cycle: find out what we cannot see from chat, then decide.
 *
 * Verification is async (a `glab` call, a haiku classification) and the reducer
 * is not, so the two are separated: facts are settled first, and the tick that
 * follows acts only on what came back. A verification that fails leaves no fact
 * behind, so the tick simply finds nothing to do.
 */
export function runCycle(session: Session, ctx: SessionContext): void {
  void verifyFacts(session, ctx)
    .catch((err) => log.debug(`Chain verification failed: ${err}`))
    .finally(() => runTick(session, ctx));
}

/**
 * Resolve the two questions chat cannot answer, writing results into the state:
 * whether an MR is approved, and whether a finished review demanded changes.
 */
async function verifyFacts(session: Session, ctx: SessionContext): Promise<void> {
  if (!enabled(ctx)) return;
  const state = getChainState(session);
  if (state.verifying) return;
  state.verifying = true;
  try {
    await judgeOwnReview(session, ctx, state);
    await judgeFinishedReviews(session, ctx, state);
    await refreshApprovals(session, ctx, state);
  } finally {
    state.verifying = false;
  }
}

/**
 * When WE are the reviewer, our own finished review is the one we can judge
 * exactly: the turn ended, and the text we are about to hand back is right here.
 *
 * A clean review that never becomes an approval is the failure this catches. It
 * is the same step as on the requester's side, but owned by our own agent, which
 * means it is fixed by an instruction rather than by waiting on somebody else.
 */
async function judgeOwnReview(
  session: Session,
  ctx: SessionContext,
  state: ChainSessionState
): Promise<void> {
  const now = Date.now();
  if (!state.lastResultAt || now - state.lastResultAt < SETTLE_MS) return;
  const text = session.returnDelivery?.lastFinalText;
  if (!text?.trim()) return;

  for (const expectation of state.expectations) {
    if (expectation.kind !== 'review_handback') continue;
    const subject = expectation.subject;
    if (!subject || state.verdicts[subject]) continue;

    const verdict = await classifyReviewVerdict(text);
    if (!verdict) continue;
    state.verdicts[subject] = verdict;
    sessionLog(session).info(`⛓️ Our own review of ${subject}: ${verdict}`);

    if (verdict === 'clean') {
      state.expectations = armExpectation(state.expectations, {
        kind: 'mr_approved',
        owner: { kind: 'agent' },
        waiter: expectation.waiter,
        subject,
        now,
      });
    }
    persistIfActive(session, ctx);
  }
}

/**
 * A review is finished when the reviewer has gone quiet — their `result` event
 * happens in another process, so silence after speaking is the only end we can
 * observe. Once finished, its conclusion decides whether an approval is owed:
 * demanding one after a review that asked for changes would be nagging for the
 * wrong thing entirely.
 */
async function judgeFinishedReviews(
  session: Session,
  ctx: SessionContext,
  state: ChainSessionState
): Promise<void> {
  const window = policy(ctx).workSilenceMs;
  const now = Date.now();

  for (const expectation of state.expectations) {
    if (expectation.kind !== 'review_reply' || expectation.state !== 'satisfied') continue;
    const subject = expectation.subject;
    if (!subject || state.verdicts[subject]) continue;

    const key = partyKey(expectation.owner);
    const lastSeen = state.lastSeen[key] ?? 0;
    if (!lastSeen || now - lastSeen < window) continue; // still talking — not finished

    const text = partyTranscript(state, key);
    if (!text) continue;

    const verdict = await classifyReviewVerdict(text);
    if (!verdict) continue;
    state.verdicts[subject] = verdict;
    sessionLog(session).info(`⛓️ Review verdict on ${subject}: ${verdict}`);

    if (verdict === 'clean' && expectation.owner.kind === 'bot') {
      // Clean review, no approval yet observed: the reviewer owes the button.
      state.expectations = armExpectation(state.expectations, {
        kind: 'mr_approved',
        owner: expectation.owner,
        waiter: { kind: 'agent' },
        subject,
        now,
      });
    }
    persistIfActive(session, ctx);
  }
}

/** Ask GitLab about every MR we are still waiting on an approval for. */
async function refreshApprovals(
  session: Session,
  ctx: SessionContext,
  state: ChainSessionState
): Promise<void> {
  const now = Date.now();

  for (const expectation of openExpectations(state.expectations)) {
    if (expectation.kind !== 'mr_approved' || !expectation.subject) continue;
    const subject = expectation.subject;

    const cached = state.approvals[subject];
    if (cached && now - cached.at < APPROVAL_CACHE_MS) {
      if (cached.approved) satisfyApproval(session, ctx, state, expectation.id, subject);
      continue;
    }

    const approved = await checkMrApproved(subject);
    state.approvals[subject] = { at: Date.now(), approved };
    if (approved) satisfyApproval(session, ctx, state, expectation.id, subject);
  }
}

/** The approval exists: close the step and tell the human who asked. */
function satisfyApproval(
  session: Session,
  ctx: SessionContext,
  state: ChainSessionState,
  id: string,
  subject: string
): void {
  state.expectations = settleExpectation(state.expectations, id, 'satisfied', 'approved in GitLab');
  sessionLog(session).info(`⛓️ ${subject} is approved`);
  persistIfActive(session, ctx);
  void reportTaskDone(session, ctx, state, subject);
}

/**
 * Tell the human who asked that their task is finished.
 *
 * Done by the bot, not asked of the agent: the agent's answer already sits in
 * this thread, so what is missing is a mention that reaches the requester's
 * notifications. A teammate requester is skipped — the hand-back already covers
 * them, and two "готово" for one task is how a thread becomes noise.
 */
async function reportTaskDone(
  session: Session,
  ctx: SessionContext,
  state: ChainSessionState,
  subject: string
): Promise<void> {
  if (state.reported.includes(subject)) return;
  const requester = session.startedBy;
  if (!requester) return;
  if (partyForUser(session, ctx, requester).kind !== 'human') return;

  state.reported.push(subject);
  state.expectations = armExpectation(state.expectations, {
    kind: 'task_report',
    owner: { kind: 'agent' },
    waiter: { kind: 'human', name: requester },
    subject,
    now: Date.now(),
  });
  persistIfActive(session, ctx);

  try {
    await post(session, 'info', `@${requester} готово: ${subject} прошёл ревью и одобрен.`);
    state.expectations = settleExpectation(
      state.expectations,
      expectationId('task_report', subject),
      'satisfied',
      'reported by the bot'
    );
    persistIfActive(session, ctx);
    sessionLog(session).info(`⛓️ Told @${requester} the task is done`);
  } catch (err) {
    // Left open on purpose: the ladder will ask the agent to say it instead.
    log.debug(`Task report failed: ${err}`);
  }
}

/** Advance the chain and perform whatever it decided. Never throws. */
export function runTick(session: Session, ctx: SessionContext): void {
  if (!enabled(ctx)) return;
  if (!ctx.state.sessions.has(session.sessionId)) return;
  const state = getChainState(session);
  if (openExpectations(state.expectations).length === 0) {
    ensureTimer(session, ctx);
    return;
  }

  const { expectations, actions } = tick(state.expectations, buildFacts(session), policy(ctx));
  state.expectations = expectations;

  if (actions.length > 0) persistIfActive(session, ctx);
  for (const action of actions) {
    void execute(session, ctx, action).catch((err) => log.debug(`Chain action failed: ${err}`));
  }
  ensureTimer(session, ctx);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Who to pull in. Configured targets win; otherwise whoever started the session. */
function escalationMentions(session: Session, ctx: SessionContext): string {
  const configured = ctx.config.arbiterPolicy?.escalateTo?.filter((t) => t.trim());
  const targets = configured?.length ? configured : [session.startedBy].filter(Boolean);
  return targets.map((t) => `@${t.replace(/^@/, '')}`).join(' ');
}

async function execute(session: Session, ctx: SessionContext, action: ChainAction): Promise<void> {
  const { expectation } = action;

  if (action.type === 'nag_agent') {
    // Same safety gate the rest of the arbiter uses: a pending approval or
    // question means a human is mid-conversation with the agent, and injecting
    // an instruction there answers nothing and confuses everything.
    if (!canIntervene(session)) return;
    try {
      session.claude.sendMessage(agentNudge(expectation));
      session.isProcessing = true;
      session.lastActivityAt = new Date();
      ctx.ops.startTyping(session);
      sessionLog(session).info(`⛓️ Nudged the agent: ${stepDescription(expectation)}`);
    } catch (err) {
      log.debug(`Chain nudge failed: ${err}`);
    }
    return;
  }

  if (action.type === 'ping_bot') {
    await post(session, 'info', botPing(expectation, action.name, Date.now()));
    sessionLog(session).info(`⛓️ Pinged @${action.name}: ${stepDescription(expectation)}`);
    return;
  }

  const mentions = escalationMentions(session, ctx);
  await post(session, 'warning', `🔔 ${humanEscalation(expectation, mentions, action.reason, Date.now())}`);
  sessionLog(session).warn(`⛓️ Escalated to humans (${action.reason}): ${stepDescription(expectation)}`);
}

/** Open steps, for the session header and the `!arbiter` listing. */
export function describeOpenSteps(session: Session): string[] {
  const state = session.arbiter?.chain;
  if (!state) return [];
  return openExpectations(state.expectations).map((e: Expectation) => stepDescription(e));
}
