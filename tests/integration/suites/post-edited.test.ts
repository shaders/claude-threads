/**
 * Does an edited post actually reach the bot?
 *
 * The review chain treats a `post_edited` event as a teammate's heartbeat. That
 * choice is load-bearing: a claude-threads bot mid-task rewrites ONE rolling tool
 * line instead of posting again, so if edits never arrive, a teammate hard at work
 * is indistinguishable from a teammate whose process died — and the silence window
 * that decides "nobody is home" (2 min before the reviewer shows up, 5 after) has
 * to be widened until it is useless.
 *
 * Nothing in the unit tests can answer this: it is a question about what Mattermost
 * broadcasts to a bot account over the websocket, and the only honest way to find
 * out is to connect a real client and edit a post as somebody else.
 *
 * Run:
 *   bun run test:integration:setup
 *   INTEGRATION_TEST=1 bun test tests/integration/suites/post-edited.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { loadConfig } from '../setup/config.js';
import { MattermostClient } from '../../../src/platform/mattermost/client.js';
import { createPlatformTestApi, type PlatformTestApi } from '../fixtures/platform-test-api.js';
import type { PlatformPost, PlatformUser } from '../../../src/platform/index.js';

const SKIP = !process.env.INTEGRATION_TEST;

/** Generous: a websocket round trip on a cold docker Mattermost is not instant. */
const EVENT_TIMEOUT_MS = 10_000;

interface Seen {
  post: PlatformPost;
  user: PlatformUser | null;
}

describe.skipIf(SKIP)('post_edited reaches the bot', () => {
  let client: MattermostClient;
  let userApi: PlatformTestApi;
  let channelId: string;

  const edited: Seen[] = [];
  const posted: Seen[] = [];

  beforeAll(async () => {
    const config = loadConfig();
    const bot = config.mattermost.bots[0];
    if (!bot?.token) throw new Error('Bot token not found. Run test:integration:setup first.');

    // A different account does the editing — an edit of our OWN post is filtered
    // out by design (a bot rewriting its own rolling line says nothing about a
    // teammate), so testing with the bot's own post would prove nothing.
    const editor = config.mattermost.testUsers[0]?.token ?? config.mattermost.admin.token;
    if (!editor) throw new Error('No editor token found. Run test:integration:setup first.');

    channelId = config.mattermost.channel.id || '';
    userApi = createPlatformTestApi('mattermost', {
      baseUrl: config.mattermost.url,
      token: editor,
      channelId,
    });

    client = new MattermostClient({
      id: 'mattermost-post-edited',
      type: 'mattermost',
      displayName: 'post_edited probe',
      url: config.mattermost.url,
      token: bot.token,
      channelId,
      botName: bot.username,
      allowedUsers: [],
    });

    client.on('post_edited', (post: PlatformPost, user: PlatformUser | null) => {
      edited.push({ post, user });
    });
    client.on('message', (post: PlatformPost, user: PlatformUser | null) => {
      posted.push({ post, user });
    });

    await client.connect();
  });

  afterAll(() => {
    client?.disconnect();
  });

  it('emits post_edited when somebody else rewrites a post in the channel', async () => {
    const created = await userApi.createPost({ channelId, message: 'первая версия строки' });

    // The post itself must arrive first — if this fails the probe is broken, not
    // the feature, and the edit assertion below would be meaningless.
    await waitFor(() => posted.some((p) => p.post.id === created.id), 'the original post');

    await userApi.updatePost(created.id, 'первая версия строки — обновлено');

    const arrived = await waitFor(
      () => edited.some((e) => e.post.id === created.id),
      'the edited post',
      /* soft */ true
    );

    // A hard failure here is a real answer, not a flake: it means the chain's
    // liveness signal does not exist on this server, and `workSilenceMs` must be
    // raised (or typing events used instead) before trusting a short window.
    expect(arrived).toBe(true);

    const event = edited.find((e) => e.post.id === created.id);
    expect(event?.post.message).toContain('обновлено');
    // The author has to be identifiable, or the chain cannot tell WHOSE heartbeat
    // this is — an anonymous edit is not a usable signal.
    expect(event?.user?.username).toBeTruthy();
  });

  it('ignores the bot editing its own post', async () => {
    const own = await client.createPost('строка бота', undefined);
    const before = edited.length;

    await client.updatePost(own!.id, 'строка бота — переписана');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Our own edits are not evidence about anybody else, and treating them as
    // activity would let a session keep its own chain alive indefinitely.
    expect(edited.slice(before).some((e) => e.post.id === own!.id)).toBe(false);
  });
});

/**
 * Poll a condition. Returns true/false rather than throwing when `soft`, so the
 * caller can assert on the outcome and produce a readable diagnosis.
 */
async function waitFor(check: () => boolean, what: string, soft = false): Promise<boolean> {
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (soft) return false;
  throw new Error(`Timed out after ${EVENT_TIMEOUT_MS}ms waiting for ${what}`);
}
