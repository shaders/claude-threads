/**
 * Tests for streaming.ts - typing indicators
 *
 * NOTE: Content flushing tests have been moved to src/operations/executors/content.test.ts
 * since that logic is now handled by ContentExecutor via MessageManager.
 * NOTE: Content-breaker tests are in src/operations/content-breaker.test.ts
 * NOTE: Task list bumping is handled by TaskListExecutor with serialization
 */

import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { startTyping, stopTyping, TYPING_INTERVAL_MS } from './handler.js';
import type { Session } from '../../session/types.js';
import { createSessionTimers, createSessionLifecycle } from '../../session/types.js';
import type { PlatformClient } from '../../platform/index.js';
import { createMockFormatter } from '../../test-utils/mock-formatter.js';

// Mock platform client (minimal version for streaming tests)
function createMockPlatform() {
  return {
    sendTyping: mock(() => {}),
    getFormatter: mock(() => createMockFormatter()),
  } as unknown as PlatformClient;
}

// Create a minimal session for testing
function createTestSession(platform: PlatformClient): Session {
  return {
    platformId: 'test',
    threadId: 'thread1',
    sessionId: 'test:thread1',
    claudeSessionId: 'uuid-123',
    agentType: 'claude',
    startedBy: 'testuser',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: 1,
    platform,
    workingDir: '/test',
    claude: null as any,
    planApproved: false,
    sessionAllowedUsers: new Set(['testuser']),
    forceInteractivePermissions: false,
    respondOnlyWhenMentioned: false,
    sessionStartPostId: 'start_post',
    sessionHeaderMode: 'full',
    timers: createSessionTimers(),
    lifecycle: createSessionLifecycle(),
    timeoutWarningPosted: false,
    messageCount: 0,
    isProcessing: false,
    recentEvents: [],
    messageManager: undefined,
  };
}

// ---------------------------------------------------------------------------
// Typing indicator tests
// ---------------------------------------------------------------------------

describe('startTyping', () => {
  let platform: PlatformClient;
  let session: Session;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
  });

  test('starts typing indicator and sets interval', () => {
    startTyping(session);

    expect(platform.sendTyping).toHaveBeenCalledWith('thread1');
    expect(session.timers.typingTimer).not.toBeNull();
  });

  test('does not restart if already typing', () => {
    startTyping(session);
    const firstTimer = session.timers.typingTimer;

    startTyping(session);

    // Timer should be the same (not restarted)
    expect(session.timers.typingTimer).toBe(firstTimer);
    // sendTyping called only once (initial call)
    expect(platform.sendTyping).toHaveBeenCalledTimes(1);
  });
});

describe('stopTyping', () => {
  let platform: PlatformClient;
  let session: Session;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
  });

  test('clears typing timer', () => {
    startTyping(session);
    expect(session.timers.typingTimer).not.toBeNull();

    stopTyping(session);

    expect(session.timers.typingTimer).toBeNull();
  });

  test('does nothing if not typing', () => {
    // Should not throw
    stopTyping(session);
    expect(session.timers.typingTimer).toBeNull();
  });
});

describe('typing pulses on a displaced session', () => {
  let platform: PlatformClient;
  let session: Session;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
  });

  afterEach(() => {
    stopTyping(session);
    jest.useRealTimers();
  });

  test('stop themselves once the session is no longer the registered one', () => {
    jest.useFakeTimers();
    let isCurrent = true;
    startTyping(session, () => isCurrent);

    jest.advanceTimersByTime(TYPING_INTERVAL_MS);
    expect(platform.sendTyping).toHaveBeenCalledTimes(2); // initial + one pulse

    // Displaced: nothing can call stopTyping on this object any more, so the
    // tick must clear itself instead of pulsing "typing…" forever.
    isCurrent = false;
    jest.advanceTimersByTime(TYPING_INTERVAL_MS * 5);

    expect(session.timers.typingTimer).toBeNull();
    expect(platform.sendTyping).toHaveBeenCalledTimes(2);
  });

  test('keep pulsing while the session is still registered', () => {
    jest.useFakeTimers();
    startTyping(session, () => true);

    jest.advanceTimersByTime(TYPING_INTERVAL_MS * 3);

    expect(session.timers.typingTimer).not.toBeNull();
    expect(platform.sendTyping).toHaveBeenCalledTimes(4);
  });
});

