/**
 * The snapshot is a wire format: an ansible-deployed shell watcher parses it with
 * jq. So the field names are a contract, not an implementation detail — rename
 * one here and the watcher goes blind while reporting everything as fine.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { buildHealthSnapshot, healthFilePath, writeHealthSnapshot } from './writer.js';

const ACCOUNTS = [
  {
    id: 'bebop', coolingUntil: null, usagePercent: 42, activeSessions: 3,
    sessionPct: 12, weekPct: 42, weekPerModelPct: 71, sessionResetsAt: 'Jul 29 at 9pm',
    weekResetsAt: 'Aug 2 at 4pm', usageProbedAt: 1_785_300_000_000,
    costUsd: 4.1, rateLimitHits24h: 0, lastRateLimitAt: null,
  },
  {
    // Never probed: every window is null, and that is different from "0% used".
    id: 'bebop2', coolingUntil: 1_800_000_000_000, usagePercent: 100, activeSessions: 0,
    sessionPct: null, weekPct: null, weekPerModelPct: null, sessionResetsAt: null,
    weekResetsAt: null, usageProbedAt: null,
    // Упирался дважды за сутки, последний раз — 30ч назад: окно 24ч этот момент
    // уже не содержит, а lastRateLimitAt обязан его помнить.
    costUsd: 0, rateLimitHits24h: 2, lastRateLimitAt: 1_785_200_000_000,
  },
];

describe('buildHealthSnapshot', () => {
  it('carries exactly the fields the watcher reads', () => {
    const snap = buildHealthSnapshot({
      maxSessions: 15,
      activeSessions: 4,
      processingSessions: 1,
      stalestProcessingSeconds: 42, costSince: 1_785_000_000_000,
      accounts: ACCOUNTS,
      now: new Date('2026-07-29T10:00:00.000Z'),
      pid: 4242,
    });

    expect(Object.keys(snap).sort()).toEqual([
      'accounts', 'activeSessions', 'costSince', 'maxSessions', 'pid',
      'processingSessions', 'stalestProcessingSeconds', 'ts',
    ]);
    expect(snap.ts).toBe('2026-07-29T10:00:00.000Z');
    expect(snap.pid).toBe(4242);
    expect(snap.accounts).toEqual(ACCOUNTS);
  });

  /** Staleness is the whole point: the watcher compares `ts` against its own clock. */
  it('stamps the write time in ISO 8601', () => {
    const snap = buildHealthSnapshot({
      maxSessions: 1, activeSessions: 0, processingSessions: 0,
      stalestProcessingSeconds: null, costSince: 1_785_000_000_000, accounts: [],
    });
    expect(new Date(snap.ts).toISOString()).toBe(snap.ts);
  });
});

describe('writeHealthSnapshot', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'health-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const snap = () => buildHealthSnapshot({
    maxSessions: 15, activeSessions: 2, processingSessions: 0,
    stalestProcessingSeconds: null, costSince: 1_785_000_000_000, accounts: ACCOUNTS,
  });

  it('writes parseable JSON and leaves no temp file behind', async () => {
    const path = join(dir, 'nested', 'health.json');

    expect(await writeHealthSnapshot(snap(), path)).toBe(true);

    expect(JSON.parse(await readFile(path, 'utf8')).maxSessions).toBe(15);
    // A leftover .tmp would be read by a watcher globbing the directory, and a
    // half-written file parses as malformed — which the watcher must treat as a
    // fault, so it would page someone over nothing.
    expect(await readdir(join(dir, 'nested'))).toEqual(['health.json']);
  });

  it('overwrites the previous snapshot in place', async () => {
    const path = join(dir, 'health.json');
    await writeHealthSnapshot(snap(), path);
    await writeHealthSnapshot(buildHealthSnapshot({
      maxSessions: 15, activeSessions: 9, processingSessions: 1,
      stalestProcessingSeconds: 5, costSince: 1_785_000_000_000, accounts: [],
    }), path);

    expect(JSON.parse(await readFile(path, 'utf8')).activeSessions).toBe(9);
  });

  /**
   * A failed heartbeat must never take down the bot. Silence is already the
   * correct outcome — the watcher reports a stale file.
   */
  it('reports failure instead of throwing when the path is unusable', async () => {
    const blocker = join(dir, 'blocked');
    await writeFile(blocker, 'not a directory');

    expect(await writeHealthSnapshot(snap(), join(blocker, 'health.json'))).toBe(false);
  });
});

describe('healthFilePath', () => {
  /** Runtime state lives beside logs and worktrees, not in .config. */
  it('sits under ~/.claude-threads', () => {
    expect(healthFilePath()).toContain(join('.claude-threads', 'health.json'));
  });
});

/**
 * The field the "stuck session" alert is built on. Null and 0 are different
 * answers — null means nothing is mid-turn, 0 means something is mid-turn and just
 * spoke — so the watcher must be able to tell them apart.
 */
describe('stalestProcessingSeconds', () => {
  it('is null when nothing is mid-turn', () => {
    const snap = buildHealthSnapshot({
      maxSessions: 15, activeSessions: 3, processingSessions: 0,
      stalestProcessingSeconds: null, costSince: 1_785_000_000_000, accounts: [],
    });
    expect(snap.stalestProcessingSeconds).toBeNull();
  });

  it('survives the round trip through JSON as a number, not a string', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'health-stale-'));
    try {
      const path = join(dir, 'health.json');
      await writeHealthSnapshot(buildHealthSnapshot({
        maxSessions: 15, activeSessions: 1, processingSessions: 1,
        stalestProcessingSeconds: 2400, costSince: 1_785_000_000_000, accounts: [],
      }), path);

      const parsed = JSON.parse(await readFile(path, 'utf8'));
      expect(parsed.stalestProcessingSeconds).toBe(2400);
      expect(typeof parsed.stalestProcessingSeconds).toBe('number');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
