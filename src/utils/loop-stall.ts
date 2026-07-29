/**
 * Event-loop stall detector.
 *
 * The bot shares a cgroup with everything its sessions spawn — claude CLIs,
 * compilers, browsers — so `MemoryHigh` throttling suspends the supervisor
 * along with them. On 2026-07-29 that stopped the process for 15 minutes: not a
 * single timer ran, all five WebSockets then timed out in the same second, and
 * five sessions were reaped as "idle" at once. The journal held a gap and
 * nothing else, so the freeze had to be reconstructed from missing lines.
 *
 * A blocked loop cannot report on itself while blocked. This notices the gap
 * right after it ends, which is where someone reading the log needs it.
 */

import { createLogger } from './logger.js';

const log = createLogger('watchdog');

export interface LoopStallWatchdogOptions {
  /** Report gaps of at least this long. Default 30s. */
  thresholdMs?: number;
  /** How often to take a sample. Default 1s. */
  sampleMs?: number;
  /** Extra handler for the observed stall, on top of the log line. */
  onStall?: (stalledMs: number) => void;
  /** Clock override, for tests. */
  now?: () => number;
}

/**
 * Start sampling the event loop. Returns the timer so callers can stop it;
 * it is `.unref()`'d, so it never keeps the process alive on its own.
 */
export function startLoopStallWatchdog(
  options: LoopStallWatchdogOptions = {}
): ReturnType<typeof setInterval> {
  const sampleMs = options.sampleMs ?? 1_000;
  const thresholdMs = options.thresholdMs ?? 30_000;
  const now = options.now ?? Date.now;

  let previous = now();
  const timer = setInterval(() => {
    const current = now();
    // Subtract the gap we asked for: what's left is time the loop owed us.
    const stalled = current - previous - sampleMs;
    previous = current;
    if (stalled < thresholdMs) return;

    log.warn(
      `Event loop stalled for ${Math.round(stalled / 1000)}s — timers, WebSocket pings ` +
      `and session bookkeeping were all frozen for that long (memory pressure or a ` +
      `blocked tick). Expect reconnects and a batch of idle-timeout kills right after this.`
    );
    options.onStall?.(stalled);
  }, sampleMs);

  timer.unref?.();
  return timer;
}
