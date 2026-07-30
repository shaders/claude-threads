/**
 * Chain verifiers — the two questions the chain cannot answer from chat alone.
 *
 * 1. "Is there an approval on this MR?" — a fact in GitLab, asked with `glab`,
 *    which the ansible role already authenticates per host under the bot's own
 *    HOME. Asked rather than inferred on purpose: an agent saying "одобрил" is
 *    exactly the kind of report that turned out not to match the button being
 *    pressed, which is why review-ping exists at all.
 *
 * 2. "Did that review ask for changes, or was it clean?" — genuinely fuzzy, so
 *    this one is a model call (haiku). It decides only whether an approval is
 *    owed; nothing is nagged about on the strength of it.
 *
 * Both are permissive about failure. An unknown answer produces no fact, and no
 * fact produces no action — a broken `glab`, an expired token or a timed-out
 * model call must never turn into a reminder about something we cannot see.
 */

import { spawn } from 'child_process';
import { quickQuery } from '../../../claude/quick-query.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('arb-chain');

/** Hard cap on a glab call — this runs inside the bot process. */
const GLAB_TIMEOUT_MS = 10_000;

/** How long an approval answer is trusted before asking GitLab again. */
export const APPROVAL_CACHE_MS = 60_000;

/** Cap on the review text handed to the classifier. */
const MAX_VERDICT_TEXT = 2000;

export interface MrRef {
  /** Host, so a fleet spanning gitlab.com and a corp instance asks the right one. */
  host: string;
  /** URL-encoded `group/subgroup/project`, ready for the API path. */
  projectPath: string;
  iid: string;
}

/**
 * Pull the project and MR number out of a merge-request URL.
 *
 * Handles nested groups (`a/b/c/-/merge_requests/7`) because Pushwoosh uses them,
 * and GitHub PR urls return null — the chain's approval step is GitLab-only, and
 * pretending otherwise would nag about an approval nobody can give.
 */
export function parseMrUrl(url: string): MrRef | null {
  const match = /^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/.exec(url.trim());
  if (!match) return null;
  const [, host, path, iid] = match;
  return { host, projectPath: encodeURIComponent(path), iid };
}

/** Run `glab api <path>` against a host and parse the JSON. Null on any failure. */
async function glabApi(host: string, apiPath: string): Promise<unknown | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: unknown | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('glab', ['api', apiPath], {
        // GITLAB_HOST rather than --hostname: it is what glab reads for both the
        // API base and the credential lookup, so one variable keeps them aligned.
        env: { ...process.env, GITLAB_HOST: host },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      log.debug(`glab spawn failed: ${err}`);
      return done(null);
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      log.debug(`glab api timed out: ${apiPath}`);
      done(null);
    }, GLAB_TIMEOUT_MS);
    timer.unref?.();

    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', () => { /* glab is chatty on stderr; the exit code is what matters */ });
    child.on('error', (err) => {
      clearTimeout(timer);
      log.debug(`glab api error: ${err}`);
      done(null);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        log.debug(`glab api exited ${code}: ${apiPath}`);
        return done(null);
      }
      try {
        done(JSON.parse(stdout));
      } catch {
        done(null);
      }
    });
  });
}

/**
 * Read an approval verdict out of an `/approvals` payload.
 *
 * Both shapes GitLab returns are accepted: the boolean summary and the list of
 * approvers. Exported and pure so the mapping is pinned by a test rather than by
 * whatever the corp instance happened to answer the day this was written.
 */
export function parseApprovals(payload: unknown): boolean | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as { approved?: unknown; approved_by?: unknown };
  if (typeof obj.approved === 'boolean') return obj.approved;
  if (Array.isArray(obj.approved_by)) return obj.approved_by.length > 0;
  return null;
}

/** A merged or closed MR needs no approval — the step is over either way. */
export function parseMrSettled(payload: unknown): boolean | null {
  if (!payload || typeof payload !== 'object') return null;
  const state = (payload as { state?: unknown }).state;
  if (typeof state !== 'string') return null;
  return state === 'merged' || state === 'closed';
}

/**
 * Is this MR approved (or already past needing it)?
 * `null` means we could not find out — deliberately distinct from `false`.
 */
export async function checkMrApproved(url: string): Promise<boolean | null> {
  const ref = parseMrUrl(url);
  if (!ref) return null;

  const approvals = await glabApi(ref.host, `projects/${ref.projectPath}/merge_requests/${ref.iid}/approvals`);
  const approved = parseApprovals(approvals);
  if (approved === true) return true;

  // Not approved, or the instance does not expose approvals to us. Either way a
  // merged MR is not something to chase an approval for.
  const mr = await glabApi(ref.host, `projects/${ref.projectPath}/merge_requests/${ref.iid}`);
  const settled = parseMrSettled(mr);
  if (settled === true) return true;

  // We reached the API and it said "no approval": a real `false`. If neither call
  // parsed, we know nothing and say so.
  return approved === false || settled === false ? false : null;
}

export type ReviewVerdict = 'clean' | 'fixes';

/** Parse the classifier's answer. Exported for tests. */
export function parseReviewVerdict(response: string): ReviewVerdict | null {
  const match = response.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { verdict?: unknown };
    if (parsed.verdict === 'clean' || parsed.verdict === 'fixes') return parsed.verdict;
    return null;
  } catch {
    return null;
  }
}

export function buildVerdictPrompt(text: string): string {
  return `A code reviewer just finished reviewing a merge request and said this:
"""
${text.slice(-MAX_VERDICT_TEXT)}
"""

Classify the review's conclusion:
- "clean": nothing has to change before merging. Praise, nits explicitly marked optional, or "looks good" all count as clean.
- "fixes": the author has to change something first — a bug, a blocking objection, a required change, or the reviewer says they will re-check after edits.

If the text does not read like a finished review at all, answer "fixes": the safe error is to expect more work, never to expect an approval that should not exist.

Respond with ONLY a JSON object, no other text:
{"verdict": "clean" | "fixes"}`;
}

/** Classify a finished review. Null when the model was unusable or timed out. */
export async function classifyReviewVerdict(text: string): Promise<ReviewVerdict | null> {
  if (!text.trim()) return null;
  const result = await quickQuery({
    prompt: buildVerdictPrompt(text),
    model: 'haiku',
    timeout: 15_000,
  });
  if (!result.success || !result.response) return null;
  return parseReviewVerdict(result.response);
}
