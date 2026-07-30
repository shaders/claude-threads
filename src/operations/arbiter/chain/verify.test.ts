/**
 * Tests for the chain verifiers' pure parts.
 *
 * The GitLab shapes matter more than they look: `approved: false` and "we could
 * not find out" must stay different answers, because one of them is allowed to
 * produce a reminder and the other must never do so.
 */

import { describe, test, expect } from 'bun:test';
import { buildVerdictPrompt, parseApprovals, parseMrSettled, parseMrUrl, parseReviewVerdict } from './verify.js';

describe('parseMrUrl', () => {
  test('handles nested groups', () => {
    expect(parseMrUrl('https://gitlab.corp.pushwoosh.com/DevOps/ai/team/-/merge_requests/95')).toEqual({
      host: 'gitlab.corp.pushwoosh.com',
      projectPath: encodeURIComponent('DevOps/ai/team'),
      iid: '95',
    });
  });

  test('keeps the host, so a mixed fleet asks the right instance', () => {
    expect(parseMrUrl('https://gitlab.com/a/b/-/merge_requests/1')?.host).toBe('gitlab.com');
  });

  test('rejects anything that is not a GitLab merge request', () => {
    // A GitHub PR has no approvals endpoint here; nagging for one would be a
    // reminder about a button that does not exist.
    expect(parseMrUrl('https://github.com/user/repo/pull/123')).toBeNull();
    expect(parseMrUrl('not a url')).toBeNull();
    expect(parseMrUrl('https://gitlab.com/a/b/-/issues/3')).toBeNull();
  });
});

describe('parseApprovals', () => {
  test('reads the boolean summary', () => {
    expect(parseApprovals({ approved: true })).toBe(true);
    expect(parseApprovals({ approved: false })).toBe(false);
  });

  test('falls back to the approver list', () => {
    expect(parseApprovals({ approved_by: [{ user: { username: 'rocksteady' } }] })).toBe(true);
    expect(parseApprovals({ approved_by: [] })).toBe(false);
  });

  test('says "unknown" rather than "no" when the shape is unfamiliar', () => {
    expect(parseApprovals({})).toBeNull();
    expect(parseApprovals(null)).toBeNull();
    expect(parseApprovals('403 Forbidden')).toBeNull();
  });
});

describe('parseMrSettled', () => {
  test('merged or closed needs no approval', () => {
    expect(parseMrSettled({ state: 'merged' })).toBe(true);
    expect(parseMrSettled({ state: 'closed' })).toBe(true);
    expect(parseMrSettled({ state: 'opened' })).toBe(false);
    expect(parseMrSettled({})).toBeNull();
  });
});

describe('parseReviewVerdict', () => {
  test('accepts either verdict, in prose or bare JSON', () => {
    expect(parseReviewVerdict('{"verdict": "clean"}')).toBe('clean');
    expect(parseReviewVerdict('Here you go: {"verdict":"fixes"} — hope that helps')).toBe('fixes');
  });

  test('returns null on anything unusable, so nothing is armed on a guess', () => {
    expect(parseReviewVerdict('looks good to me')).toBeNull();
    expect(parseReviewVerdict('{"verdict": "maybe"}')).toBeNull();
    expect(parseReviewVerdict('{broken')).toBeNull();
  });
});

describe('buildVerdictPrompt', () => {
  test('defaults an unclear review to "fixes"', () => {
    // The asymmetry is deliberate and worth pinning: expecting more work is a
    // wasted question, expecting an approval that should not exist is a bot
    // being told to rubber-stamp a broken MR.
    expect(buildVerdictPrompt('...')).toContain('answer "fixes"');
  });
});
