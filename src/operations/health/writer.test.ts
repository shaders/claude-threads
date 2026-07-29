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
  { id: 'bebop', coolingUntil: null, usagePercent: 42, activeSessions: 3 },
  { id: 'bebop2', coolingUntil: 1_800_000_000_000, usagePercent: 100, activeSessions: 0 },
];

describe('buildHealthSnapshot', () => {
  it('carries exactly the fields the watcher reads', () => {
    const snap = buildHealthSnapshot({
      maxSessions: 15,
      activeSessions: 4,
      processingSessions: 1,
      accounts: ACCOUNTS,
      now: new Date('2026-07-29T10:00:00.000Z'),
      pid: 4242,
    });

    expect(Object.keys(snap).sort()).toEqual([
      'accounts', 'activeSessions', 'maxSessions', 'pid', 'processingSessions', 'ts',
    ]);
    expect(snap.ts).toBe('2026-07-29T10:00:00.000Z');
    expect(snap.pid).toBe(4242);
    expect(snap.accounts).toEqual(ACCOUNTS);
  });

  /** Staleness is the whole point: the watcher compares `ts` against its own clock. */
  it('stamps the write time in ISO 8601', () => {
    const snap = buildHealthSnapshot({
      maxSessions: 1, activeSessions: 0, processingSessions: 0, accounts: [],
    });
    expect(new Date(snap.ts).toISOString()).toBe(snap.ts);
  });
});

describe('writeHealthSnapshot', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'health-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const snap = () => buildHealthSnapshot({
    maxSessions: 15, activeSessions: 2, processingSessions: 0, accounts: ACCOUNTS,
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
      maxSessions: 15, activeSessions: 9, processingSessions: 1, accounts: [],
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
