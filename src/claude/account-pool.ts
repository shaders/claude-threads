/**
 * AccountPool — round-robin selector over a pool of Claude accounts.
 *
 * Responsibilities:
 * - Hand out an account for a new session (round-robin, skipping cooling accounts).
 * - Track which accounts are currently in rate-limit cooldown so future sessions
 *   route around them. Resume of existing sessions bypasses cooldown because the
 *   conversation history lives under that account's HOME and can't be moved.
 * - Track usage counts for UI display (sticky message).
 *
 * Single-account mode: pass an empty array (or `undefined`) to the constructor
 * and every method returns `null` — the bot then falls back to `process.env` as
 * it does today.
 */
import type { ClaudeAccount } from '../config/types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('account-pool');

/** Snapshot of pool state for UI/debug. */
export interface AccountPoolStatus {
  id: string;
  displayName: string;
  activeSessions: number;
  coolingUntil: number | null; // epoch ms, null = available
}

export class AccountPool {
  private readonly accounts: ClaudeAccount[];
  private readonly byId: Map<string, ClaudeAccount>;
  private readonly activeCounts: Map<string, number> = new Map();
  private readonly coolingUntil: Map<string, number> = new Map();
  private roundRobinIndex = 0;

  constructor(accounts?: ClaudeAccount[]) {
    this.accounts = (accounts ?? []).filter((acc) => {
      const hasAuth = !!acc.home || !!acc.apiKey;
      if (!hasAuth) {
        log.warn(`Claude account ${acc.id} has neither home nor apiKey — ignoring`);
        return false;
      }
      // home and apiKey are documented as mutually exclusive. Dropping here
      // is the natural chokepoint so the later spawn path in cli.ts doesn't
      // silently pick one over the other.
      if (acc.home && acc.apiKey) {
        log.warn(
          `Claude account ${acc.id} has both home and apiKey set — must choose one; ignoring`
        );
        return false;
      }
      return true;
    });
    this.byId = new Map(this.accounts.map((acc) => [acc.id, acc]));
    for (const acc of this.accounts) {
      this.activeCounts.set(acc.id, 0);
    }
  }

  /** True when no accounts are configured — caller should use default env. */
  get isEmpty(): boolean {
    return this.accounts.length === 0;
  }

  /** Number of configured accounts. */
  get size(): number {
    return this.accounts.length;
  }

  /**
   * Acquire the next available account via round-robin, skipping cooling ones.
   *
   * If `preferredId` is given and that account exists, it is returned as-is —
   * even if it's currently cooling. This path is used when resuming an existing
   * session whose conversation history lives under that account's HOME.
   *
   * Returns `null` when the pool is empty, or when every account is cooling
   * and no `preferredId` was supplied.
   */
  acquire(preferredId?: string): ClaudeAccount | null {
    if (this.isEmpty) return null;

    if (preferredId) {
      const preferred = this.byId.get(preferredId);
      if (preferred) {
        this.incrementActive(preferred.id);
        return preferred;
      }
      log.warn(`Preferred account "${preferredId}" not in pool — falling back to round-robin`);
    }

    const now = Date.now();
    const n = this.accounts.length;
    for (let i = 0; i < n; i++) {
      const idx = (this.roundRobinIndex + i) % n;
      const candidate = this.accounts[idx];
      const cooling = this.coolingUntil.get(candidate.id) ?? 0;
      if (cooling <= now) {
        this.roundRobinIndex = (idx + 1) % n;
        this.incrementActive(candidate.id);
        return candidate;
      }
    }

    log.warn(`All ${n} accounts are in rate-limit cooldown`);
    return null;
  }

  /**
   * Release an account — caller invokes this when a session ends so usage
   * accounting stays accurate. No-op if the id isn't in the pool.
   */
  release(accountId: string): void {
    const current = this.activeCounts.get(accountId);
    if (current === undefined) return;
    this.activeCounts.set(accountId, Math.max(0, current - 1));
  }

  /**
   * Mark an account as rate-limited until `untilEpochMs`. Subsequent `acquire()`
   * calls without `preferredId` will skip this account until the timestamp passes.
   */
  markCooling(accountId: string, untilEpochMs: number): void {
    if (!this.byId.has(accountId)) {
      log.warn(`markCooling called for unknown account "${accountId}"`);
      return;
    }
    const existing = this.coolingUntil.get(accountId) ?? 0;
    // Only extend cooldown, never shorten it.
    if (untilEpochMs > existing) {
      this.coolingUntil.set(accountId, untilEpochMs);
      const minutes = Math.ceil((untilEpochMs - Date.now()) / 60000);
      log.info(`Account "${accountId}" cooling for ~${minutes}min`);
    }
  }

  /** Look up an account by id. Returns undefined for unknown ids. */
  get(accountId: string): ClaudeAccount | undefined {
    return this.byId.get(accountId);
  }

  /** Snapshot of pool state — for UI / sticky message / debug logs. */
  status(): AccountPoolStatus[] {
    const now = Date.now();
    return this.accounts.map((acc) => {
      const cooling = this.coolingUntil.get(acc.id) ?? 0;
      return {
        id: acc.id,
        displayName: acc.displayName ?? acc.id,
        activeSessions: this.activeCounts.get(acc.id) ?? 0,
        coolingUntil: cooling > now ? cooling : null,
      };
    });
  }

  private incrementActive(accountId: string): void {
    this.activeCounts.set(accountId, (this.activeCounts.get(accountId) ?? 0) + 1);
  }
}
