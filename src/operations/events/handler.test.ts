/**
 * Tests for events.ts - Pre/post processing and session-specific side effects
 *
 * NOTE: Main event handling (formatting, tool handling) is now tested in
 * src/operations/ tests. This file tests session-specific side effects that
 * wrap the MessageManager.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
  handleEventPreProcessing,
  handleEventPostProcessing,
  attachFile,
} from './handler.js';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SessionContext } from '../session-context/index.js';
import type { Session } from '../../session/types.js';
import { createSessionTimers, createSessionLifecycle } from '../../session/types.js';
import type { PlatformClient, PlatformPost } from '../../platform/index.js';
import { createMockFormatter } from '../../test-utils/mock-formatter.js';

// Mock platform client
function createMockPlatform() {
  const posts: Map<string, string> = new Map();
  let postIdCounter = 1;

  const mockPlatform = {
    getBotUser: mock(async () => ({
      id: 'bot',
      username: 'bot',
      displayName: 'Bot',
    })),
    createPost: mock(async (message: string, _threadId?: string): Promise<PlatformPost> => {
      const id = `post_${postIdCounter++}`;
      posts.set(id, message);
      return {
        id,
        platformId: 'test',
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: _threadId || '',
        createAt: Date.now(),
      };
    }),
    updatePost: mock(async (postId: string, message: string): Promise<PlatformPost> => {
      posts.set(postId, message);
      return {
        id: postId,
        platformId: 'test',
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: '',
        createAt: Date.now(),
      };
    }),
    deletePost: mock(async (postId: string): Promise<void> => {
      posts.delete(postId);
    }),
    createInteractivePost: mock(async (message: string, _reactions: string[], _threadId?: string): Promise<PlatformPost> => {
      const id = `post_${postIdCounter++}`;
      posts.set(id, message);
      return {
        id,
        platformId: 'test',
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: _threadId || '',
        createAt: Date.now(),
      };
    }),
    pinPost: mock(async (_postId: string): Promise<void> => {}),
    unpinPost: mock(async (_postId: string): Promise<void> => {}),
    sendTyping: mock(() => {}),
    getFormatter: () => createMockFormatter(),
    getThreadHistory: mock(async (_threadId: string, _options?: { limit?: number }) => {
      return [];
    }),
    posts,
  };

  return mockPlatform as unknown as PlatformClient & { posts: Map<string, string> };
}

// Create a minimal session for testing
function createTestSession(platform: PlatformClient): Session {
  return {
    platformId: 'test',
    threadId: 'thread1',
    sessionId: 'test:thread1',
    claudeSessionId: 'uuid-123',
    startedBy: 'testuser',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: 1,
    platform,
    workingDir: '/test',
    claude: {
      isRunning: () => true,
      sendMessage: mock(() => {}),
      getStatusData: () => null,
    } as any,
    planApproved: false,
    sessionAllowedUsers: new Set(['testuser']),
    forceInteractivePermissions: false,
    sessionStartPostId: 'start_post',
    timers: createSessionTimers(),
    lifecycle: createSessionLifecycle(),
    timeoutWarningPosted: false,
    messageCount: 0,
    isProcessing: false,
    recentEvents: [],
    messageManager: undefined,
  };
}

function createSessionContext(): SessionContext {
  return {
    config: {
      debug: false,
      workingDir: '/test',
      permissionMode: 'bypass',
      chromeEnabled: false,
      maxSessions: 5,
    },
    state: {
      sessions: new Map(),
      postIndex: new Map(),
      platforms: new Map(),
      sessionStore: { save: () => {}, remove: () => {}, load: () => new Map(), findByPostId: () => undefined, cleanStale: () => [] } as any,
      isShuttingDown: false,
    },
    ops: {
      getSessionId: (_p, t) => t,
      findSessionByThreadId: () => undefined,
      registerPost: mock((_postId: string, _threadId: string) => {}),
      flush: mock(async (_session: Session) => {}),
      startTyping: mock((_session: Session) => {}),
      stopTyping: mock((_session: Session) => {}),
      updateStickyMessage: mock(async () => {}),
      persistSession: mock((_session: Session) => {}),
      updateSessionHeader: mock(async (_session: Session) => {}),
      unpersistSession: mock((_sessionId: string) => {}),
      buildMessageContent: mock(async (text: string) => ({ content: text, skipped: [] })),
      handleEvent: mock((_sessionId: string, _event: any) => {}),
      handleExit: mock(async (_sessionId: string, _code: number) => {}),
      killSession: mock(async (_threadId: string) => {}),
      shouldPromptForWorktree: mock(async (_session: Session) => null),
      postWorktreePrompt: mock(async (_session: Session, _reason: string) => {}),
      offerContextPrompt: mock(async (_session: Session, _queuedPrompt: string) => false),
      emitSessionAdd: mock(() => {}),
      emitSessionUpdate: mock(() => {}),
      emitSessionRemove: mock(() => {}),
      registerWorktreeUser: mock(() => {}),
      unregisterWorktreeUser: mock(() => {}),
      hasOtherSessionsUsingWorktree: mock(() => false),
      switchToWorktree: mock(async () => {}),
      forceUpdate: mock(async () => {}),
      deferUpdate: mock(() => {}),
      handleBugReportApproval: mock(async () => {}),
      acquireClaudeAccount: mock(() => null),
      getClaudeAccount: mock(() => undefined),
      releaseClaudeAccount: mock(() => {}),
      markClaudeAccountCooling: mock(() => {}),
      getClaudeAccountPoolStatus: mock(() => []),
    },
  };
}

describe('handleEventPreProcessing', () => {
  let platform: PlatformClient;
  let session: Session;
  let ctx: SessionContext;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createSessionContext();
  });

  test('resets session activity on any event', () => {
    const oldTime = new Date(Date.now() - 10000);
    session.lastActivityAt = oldTime;

    handleEventPreProcessing(session, { type: 'assistant' }, ctx);

    expect(session.lastActivityAt.getTime()).toBeGreaterThan(oldTime.getTime());
  });

  test('sets hasClaudeResponded on first assistant event', () => {
    expect(session.lifecycle.hasClaudeResponded).toBe(false);

    handleEventPreProcessing(session, { type: 'assistant' }, ctx);

    expect(session.lifecycle.hasClaudeResponded).toBe(true);
    expect(ctx.ops.persistSession).toHaveBeenCalled();
  });

  test('sets hasClaudeResponded on first tool_use event', () => {
    expect(session.lifecycle.hasClaudeResponded).toBe(false);

    handleEventPreProcessing(session, { type: 'tool_use', tool_use: { name: 'Read' } }, ctx);

    expect(session.lifecycle.hasClaudeResponded).toBe(true);
  });

  test('does not set hasClaudeResponded again if already set', () => {
    session.lifecycle.hasClaudeResponded = true;
    const callCount = (ctx.ops.persistSession as ReturnType<typeof mock>).mock.calls.length;

    handleEventPreProcessing(session, { type: 'assistant' }, ctx);

    // Should not persist again
    expect((ctx.ops.persistSession as ReturnType<typeof mock>).mock.calls.length).toBe(callCount);
  });

  test('captures slash_commands from init event', () => {
    expect(session.availableSlashCommands).toBeUndefined();

    const initEvent = {
      type: 'system',
      subtype: 'init',
      slash_commands: ['compact', 'context', 'cost', 'init', 'review', 'security-review'],
    };

    handleEventPreProcessing(session, initEvent, ctx);

    expect(session.availableSlashCommands).toBeDefined();
    expect(session.availableSlashCommands?.size).toBe(6);
    expect(session.availableSlashCommands?.has('compact')).toBe(true);
    expect(session.availableSlashCommands?.has('review')).toBe(true);
  });

  test('handles slash_commands with leading slashes', () => {
    const initEvent = {
      type: 'system',
      subtype: 'init',
      slash_commands: ['/compact', '/context', '/cost'],
    };

    handleEventPreProcessing(session, initEvent, ctx);

    expect(session.availableSlashCommands?.size).toBe(3);
    // Leading slashes should be stripped
    expect(session.availableSlashCommands?.has('compact')).toBe(true);
    expect(session.availableSlashCommands?.has('/compact')).toBe(false);
  });

  test('ignores init event without slash_commands', () => {
    const initEvent = {
      type: 'system',
      subtype: 'init',
      // No slash_commands field
    };

    handleEventPreProcessing(session, initEvent, ctx);

    expect(session.availableSlashCommands).toBeUndefined();
  });
});

describe('handleEventPostProcessing', () => {
  let platform: PlatformClient;
  let session: Session;
  let ctx: SessionContext;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createSessionContext();
  });

  test('stops typing on result event', () => {
    handleEventPostProcessing(session, { type: 'result' }, ctx);

    expect(ctx.ops.stopTyping).toHaveBeenCalled();
    expect(session.isProcessing).toBe(false);
  });

  test('extracts PR URL from assistant text', () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [{
          type: 'text',
          text: 'Created PR: https://github.com/user/repo/pull/123',
        }],
      },
    };

    handleEventPostProcessing(session, event, ctx);

    expect(session.pullRequestUrl).toBe('https://github.com/user/repo/pull/123');
    expect(ctx.ops.persistSession).toHaveBeenCalled();
  });

  test('does not overwrite existing PR URL', () => {
    session.pullRequestUrl = 'https://github.com/user/repo/pull/100';

    const event = {
      type: 'assistant' as const,
      message: {
        content: [{
          type: 'text',
          text: 'Created PR: https://github.com/user/repo/pull/200',
        }],
      },
    };

    handleEventPostProcessing(session, event, ctx);

    expect(session.pullRequestUrl).toBe('https://github.com/user/repo/pull/100');
  });

  // NOTE: Subagent toggle reaction tests have been moved to subagent.test.ts
  // since that functionality is now handled by SubagentExecutor via MessageManager

  // NOTE: postCurrentQuestion tests have been removed - question posting now
  // goes through QuestionApprovalExecutor via MessageManager
});

describe('attachFile', () => {
  let workDir: string;
  let outsideDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'claude-threads-attach-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'claude-threads-outside-'));
  });

  // NOTE: there is no afterEach cleanup for these tmp dirs by design — bun's
  // test runner is a one-shot process and the OS reclaims /tmp on reboot. A
  // failed test that leaves a few KB behind is preferable to losing the
  // failure trail by also erroring out of cleanup.

  function setupSession(platform: PlatformClient): Session & { _sentToClaude: string[] } {
    const session = createTestSession(platform);
    session.workingDir = workDir;
    const sent: string[] = [];
    (session.claude as any).sendMessage = (msg: string) => sent.push(msg);
    (session as any)._sentToClaude = sent;
    return session as Session & { _sentToClaude: string[] };
  }

  test('happy path: uploads file and notifies Claude', async () => {
    const target = join(workDir, 'output.xlsx');
    writeFileSync(target, 'binary-content');

    const platform = createMockPlatform();
    const session = setupSession(platform);
    const ctx = createSessionContext();

    await attachFile(session, 'output.xlsx', ctx);

    expect((platform.createPost as any).mock.calls.length).toBe(1);
    const call = (platform.createPost as any).mock.calls[0];
    // 3rd arg = options bag with filePaths. The handler passes the realpath,
    // so the comparison must end-match — on macOS /var/folders symlinks to
    // /private/var/folders.
    expect(call[2].filePaths).toHaveLength(1);
    expect(call[2].filePaths[0]).toMatch(/output\.xlsx$/);
    expect(session._sentToClaude.length).toBe(1);
    expect(session._sentToClaude[0]).toContain('Attached output.xlsx');
  });

  // Helper: extract upload-shaped vs non-upload createPost calls. Rejections
  // now post a user-visible error in addition to telling Claude, so test
  // assertions need to differentiate "we tried to upload" from "we posted
  // an error explanation".
  function uploadAndUserCalls(platform: PlatformClient): {
    upload: unknown[][];
    user: unknown[][];
  } {
    const calls = ((platform.createPost as any).mock.calls as unknown[][]);
    return {
      upload: calls.filter((c) => (c[2] as { filePaths?: unknown })?.filePaths),
      user: calls.filter((c) => !(c[2] as { filePaths?: unknown })?.filePaths),
    };
  }

  test('rejects path-traversal attempt outside working directory', async () => {
    // Place a file outside workDir, then ask attach to fetch it via traversal.
    const escapeTarget = join(outsideDir, 'secret.txt');
    writeFileSync(escapeTarget, 'secret');

    const platform = createMockPlatform();
    const session = setupSession(platform);
    const ctx = createSessionContext();

    // Build a relative path that escapes workDir → ../<basename(outsideDir)>/secret.txt
    const escapeRelative = `../${outsideDir.split('/').pop()}/secret.txt`;
    await attachFile(session, escapeRelative, ctx);

    const { upload, user } = uploadAndUserCalls(platform);
    expect(upload.length).toBe(0);
    expect(user.length).toBe(1);
    expect(user[0][0]).toMatch(/outside the working directory/);
    expect(session._sentToClaude[0]).toContain('outside the working directory');
  });

  test('rejects symlink that points outside the working directory', async () => {
    // Symlink inside workDir pointing to a file outside — realpath() resolves
    // the link before the containment check, so traversal via symlink is
    // rejected just like a textual `..` would be.
    const escapeTarget = join(outsideDir, 'leaked.txt');
    writeFileSync(escapeTarget, 'leaked');
    const linkPath = join(workDir, 'shortcut.txt');
    symlinkSync(escapeTarget, linkPath);

    const platform = createMockPlatform();
    const session = setupSession(platform);
    const ctx = createSessionContext();

    await attachFile(session, 'shortcut.txt', ctx);

    const { upload, user } = uploadAndUserCalls(platform);
    expect(upload.length).toBe(0);
    expect(user.length).toBe(1);
    expect(user[0][0]).toMatch(/outside the working directory/);
    expect(session._sentToClaude[0]).toContain('outside the working directory');
  });

  test('rejects file exceeding the size cap', async () => {
    const target = join(workDir, 'big.bin');
    writeFileSync(target, Buffer.alloc(2048));  // 2 KB

    const platform = createMockPlatform();
    const session = setupSession(platform);
    const ctx = createSessionContext();
    ctx.config.attachmentsMaxBytes = 1024;  // 1 KB cap

    await attachFile(session, 'big.bin', ctx);

    const { upload, user } = uploadAndUserCalls(platform);
    expect(upload.length).toBe(0);
    expect(user.length).toBe(1);
    expect(user[0][0]).toMatch(/limit is .*KB/);
    expect(session._sentToClaude[0]).toMatch(/limit is .*KB/);
  });

  test('rejects when attachments are globally disabled', async () => {
    const target = join(workDir, 'output.xlsx');
    writeFileSync(target, 'x');

    const platform = createMockPlatform();
    const session = setupSession(platform);
    const ctx = createSessionContext();
    ctx.config.attachmentsEnabled = false;

    await attachFile(session, 'output.xlsx', ctx);

    // No upload-shaped call was attempted.
    const calls = (platform.createPost as any).mock.calls;
    const uploadCalls = calls.filter((c: unknown[]) => (c[2] as { filePaths?: unknown })?.filePaths);
    expect(uploadCalls.length).toBe(0);
    // Claude was told why it failed.
    expect(session._sentToClaude[0]).toContain('disabled');
    // Operator/user is told too — a single post with the disabled reason in
    // the chat. Pinning this assertion stops a future refactor from silently
    // turning the disabled branch into a Claude-only signal that nobody on
    // the user side notices.
    const userPosts = calls.filter((c: unknown[]) => !(c[2] as { filePaths?: unknown })?.filePaths);
    expect(userPosts.length).toBe(1);
    expect(userPosts[0][0]).toMatch(/disabled/);
  });

  test('anchors relative paths at worktree path when session is in a worktree', async () => {
    const worktreeDir = mkdtempSync(join(tmpdir(), 'claude-threads-wt-'));
    mkdirSync(join(worktreeDir, 'reports'), { recursive: true });
    const worktreeTarget = join(worktreeDir, 'reports', 'q1.pdf');
    writeFileSync(worktreeTarget, 'pdf-from-worktree');

    // Decoy: a file with the same relative path under the working directory.
    // If anchoring falls back to session.workingDir despite worktreeInfo
    // being set, the handler would resolve to this path instead. The test
    // asserts the chosen path lives inside the worktree directory, not the
    // working directory — that's what makes it RED-GREEN against an anchor
    // bug that defaulted to workingDir.
    mkdirSync(join(workDir, 'reports'), { recursive: true });
    const decoyTarget = join(workDir, 'reports', 'q1.pdf');
    writeFileSync(decoyTarget, 'pdf-from-workdir');

    const platform = createMockPlatform();
    const session = setupSession(platform);
    session.worktreeInfo = {
      repoRoot: workDir,
      worktreePath: worktreeDir,
      branch: 'feature',
    };
    const ctx = createSessionContext();

    await attachFile(session, 'reports/q1.pdf', ctx);

    expect((platform.createPost as any).mock.calls.length).toBe(1);
    const call = (platform.createPost as any).mock.calls[0];
    // Path is realpath-resolved; check the meaningful suffix and that it
    // lives under the worktree, not the workingDir.
    expect(call[2].filePaths[0]).toMatch(/reports\/q1\.pdf$/);
    expect(call[2].filePaths[0]).toContain('claude-threads-wt-');
    expect(call[2].filePaths[0]).not.toContain('claude-threads-attach-');
  });

  test('anchors relative paths at workingDir when session is not in a worktree', async () => {
    // Sibling of the worktree-anchored test — without `worktreeInfo`, the
    // handler must fall back to session.workingDir.
    mkdirSync(join(workDir, 'reports'), { recursive: true });
    const target = join(workDir, 'reports', 'q1.pdf');
    writeFileSync(target, 'pdf');

    const platform = createMockPlatform();
    const session = setupSession(platform);
    // Explicitly no worktreeInfo.
    const ctx = createSessionContext();

    await attachFile(session, 'reports/q1.pdf', ctx);

    expect((platform.createPost as any).mock.calls.length).toBe(1);
    const call = (platform.createPost as any).mock.calls[0];
    expect(call[2].filePaths[0]).toMatch(/reports\/q1\.pdf$/);
    expect(call[2].filePaths[0]).toContain('claude-threads-attach-');
  });
});
