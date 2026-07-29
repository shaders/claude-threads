/**
 * Health snapshot — the bot's own state, written to disk for an outside watcher.
 *
 * Why a file and not an endpoint: the watcher has to survive the failure it is
 * watching for. The incident this exists for was a bot whose process was alive
 * and getting CPU but had stopped answering — load average 43.7, 464 MB free of
 * 15 GB, one runaway agent Grep at 5.49 GB RSS. Anything running *inside* that
 * process was equally starved and could not have reported it. A file's staleness
 * is the one signal a wedged process cannot fake: the watcher reads `ts` and
 * decides for itself.
 *
 * So this deliberately carries only what the bot alone knows. Host facts
 * (loadavg, memory, systemd unit states) are the watcher's job — asking the
 * starved process about them would put them behind the same wedge.
 */

import { mkdir, rename, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';

/** Per-account state, mirroring AccountPoolStatus minus what a watcher can't use. */
export interface HealthAccount {
  id: string;
  /** Epoch ms until the account is rate-limited out, or null when available. */
  coolingUntil: number | null;
  /** Load score 0–100 from the last `/usage` probe, null when never probed. */
  usagePercent: number | null;
  activeSessions: number;
}

export interface HealthSnapshot {
  /** When this was written, ISO 8601. The staleness check reads exactly this. */
  ts: string;
  pid: number;
  /** Session cap for this instance, so "full" can be judged without config. */
  maxSessions: number;
  /** Sessions live in memory right now. */
  activeSessions: number;
  /** How many of those are mid-turn. */
  processingSessions: number;
  /**
   * Seconds since the last activity of the most silent mid-turn session, or null
   * when nothing is mid-turn.
   *
   * This is what separates "working hard" from "wedged", and it needs no new
   * bookkeeping: lastActivityAt is bumped on every post and every agent event, so
   * a session that is genuinely working keeps it fresh. A session that reports
   * isProcessing while this number climbs has stopped producing anything.
   */
  stalestProcessingSeconds: number | null;
  accounts: HealthAccount[];
}

/** Alongside logs and worktree state, not in .config — this is runtime, not config. */
export function healthFilePath(): string {
  return join(homedir(), '.claude-threads', 'health.json');
}

export interface HealthInput {
  maxSessions: number;
  activeSessions: number;
  processingSessions: number;
  stalestProcessingSeconds: number | null;
  accounts: HealthAccount[];
  now?: Date;
  pid?: number;
}

/** Pure, so the shape the watcher parses is pinned by tests rather than by luck. */
export function buildHealthSnapshot(input: HealthInput): HealthSnapshot {
  return {
    ts: (input.now ?? new Date()).toISOString(),
    pid: input.pid ?? process.pid,
    maxSessions: input.maxSessions,
    activeSessions: input.activeSessions,
    processingSessions: input.processingSessions,
    stalestProcessingSeconds: input.stalestProcessingSeconds,
    accounts: input.accounts,
  };
}

/**
 * Write the snapshot where a watcher can read it.
 *
 * Temp file plus rename, because the reader polls on its own schedule and a
 * half-written file would parse as "malformed" — which a watcher must treat as
 * a fault, so a torn read would page someone over nothing.
 *
 * Never throws: a failed heartbeat write must not take down the bot. The
 * consequence of silence is an alert, which is the correct outcome anyway.
 */
export async function writeHealthSnapshot(
  snapshot: HealthSnapshot,
  path = healthFilePath(),
): Promise<boolean> {
  const tmp = `${path}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}
