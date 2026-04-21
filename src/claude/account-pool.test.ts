/**
 * Tests for AccountPool.
 */
import { describe, it, expect } from 'bun:test';
import { AccountPool } from './account-pool.js';

describe('AccountPool', () => {
  describe('empty / single-account mode', () => {
    it('is empty when constructed with no accounts', () => {
      const pool = new AccountPool();
      expect(pool.isEmpty).toBe(true);
      expect(pool.size).toBe(0);
      expect(pool.acquire()).toBeNull();
    });

    it('is empty when constructed with empty array', () => {
      const pool = new AccountPool([]);
      expect(pool.isEmpty).toBe(true);
      expect(pool.acquire()).toBeNull();
    });

    it('drops accounts that have neither home nor apiKey', () => {
      const pool = new AccountPool([
        { id: 'valid', home: '/tmp/a' },
        { id: 'empty' }, // invalid
        { id: 'api', apiKey: 'sk-xxx' },
      ]);
      expect(pool.size).toBe(2);
      expect(pool.get('empty')).toBeUndefined();
      expect(pool.get('valid')).toBeDefined();
      expect(pool.get('api')).toBeDefined();
    });

    it('drops accounts that have BOTH home and apiKey (mutually exclusive)', () => {
      // home/apiKey are documented as mutually exclusive: `home` routes via
      // OAuth, `apiKey` via API billing. Silently preferring one (as the old
      // behavior did) hides misconfiguration; the pool should reject the
      // account outright so the operator notices.
      const pool = new AccountPool([
        { id: 'oauth', home: '/tmp/a' },
        { id: 'dual', home: '/tmp/b', apiKey: 'sk-ant-xxx' }, // invalid
        { id: 'api', apiKey: 'sk-ant-yyy' },
      ]);
      expect(pool.size).toBe(2);
      expect(pool.get('dual')).toBeUndefined();
      expect(pool.get('oauth')).toBeDefined();
      expect(pool.get('api')).toBeDefined();
    });
  });

  describe('acquire / round-robin', () => {
    it('returns accounts in round-robin order', () => {
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
        { id: 'c', home: '/tmp/c' },
      ]);
      expect(pool.acquire()?.id).toBe('a');
      expect(pool.acquire()?.id).toBe('b');
      expect(pool.acquire()?.id).toBe('c');
      expect(pool.acquire()?.id).toBe('a'); // wraps
    });

    it('returns preferred account when supplied and known', () => {
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
      ]);
      expect(pool.acquire('b')?.id).toBe('b');
      expect(pool.acquire('b')?.id).toBe('b');
    });

    it('falls back to round-robin when preferred id is unknown', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      expect(pool.acquire('ghost')?.id).toBe('a');
    });

    it('skips cooling accounts in round-robin', () => {
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
        { id: 'c', home: '/tmp/c' },
      ]);
      pool.markCooling('b', Date.now() + 60_000);

      expect(pool.acquire()?.id).toBe('a');
      expect(pool.acquire()?.id).toBe('c'); // b skipped
      expect(pool.acquire()?.id).toBe('a');
    });

    it('returns null when every account is cooling', () => {
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
      ]);
      const future = Date.now() + 60_000;
      pool.markCooling('a', future);
      pool.markCooling('b', future);
      expect(pool.acquire()).toBeNull();
    });

    it('returns preferred account even if it is cooling (resume path)', () => {
      const pool = new AccountPool([
        { id: 'a', home: '/tmp/a' },
        { id: 'b', home: '/tmp/b' },
      ]);
      pool.markCooling('a', Date.now() + 60_000);
      // Resuming a session that was started on 'a' must still get 'a' —
      // its history lives under a's HOME and can't move.
      expect(pool.acquire('a')?.id).toBe('a');
    });

    it('allows reacquisition after cooldown passes', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      pool.markCooling('a', Date.now() - 1); // already expired
      expect(pool.acquire()?.id).toBe('a');
    });
  });

  describe('usage accounting', () => {
    it('tracks active sessions via acquire/release', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      pool.acquire(); // 1
      pool.acquire(); // 2
      pool.release('a'); // 1
      const status = pool.status();
      expect(status[0].activeSessions).toBe(1);
    });

    it('clamps release at zero', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      pool.release('a'); // no-op effectively
      pool.release('a');
      expect(pool.status()[0].activeSessions).toBe(0);
    });

    it('ignores release for unknown accounts', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      pool.release('ghost'); // does not throw
      expect(pool.status()[0].activeSessions).toBe(0);
    });
  });

  describe('markCooling', () => {
    it('reports cooling in status()', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      const until = Date.now() + 60_000;
      pool.markCooling('a', until);
      expect(pool.status()[0].coolingUntil).toBe(until);
    });

    it('never shortens an existing cooldown', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      const far = Date.now() + 120_000;
      const near = Date.now() + 60_000;
      pool.markCooling('a', far);
      pool.markCooling('a', near);
      expect(pool.status()[0].coolingUntil).toBe(far);
    });

    it('treats expired cooldowns as available in status()', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      pool.markCooling('a', Date.now() - 1);
      expect(pool.status()[0].coolingUntil).toBeNull();
    });

    it('ignores markCooling for unknown accounts', () => {
      const pool = new AccountPool([{ id: 'a', home: '/tmp/a' }]);
      pool.markCooling('ghost', Date.now() + 60_000);
      // shouldn't throw and shouldn't appear in status
      expect(pool.status()).toHaveLength(1);
    });
  });
});
