/**
 * Tool-event normalization — the standalone shape every observer expects.
 *
 * Claude CLI reports tool CALLS as `tool_use` blocks inside `assistant`
 * messages and tool OUTCOMES as `tool_result` blocks inside `user` messages. It
 * never sends the standalone `tool_use` / `tool_result` events — Codex
 * synthesizes those. Everything that watches tool traffic keys off the
 * standalone shape (the arbiter's delivery ledger, docs-ping, return-address,
 * bug-report context), so on a Claude session all of them observed nothing:
 * an obligation could only ever be closed by a delivery the BOT made, and the
 * arbiter reminded agents about deliveries they had just performed themselves.
 *
 * Derived here rather than emitted by ClaudeCli on purpose: the transformer has
 * branches for `assistant` content blocks AND for standalone
 * `tool_use`/`tool_result` (transformer.ts:86-96), so synthetic events reaching
 * MessageManager would render every tool line twice. These are fanned out to the
 * observers only — see events/handler.ts.
 *
 * Safe for both backends. Codex's `assistant` events carry only text/thinking
 * blocks (agents/codex/translator.ts:211-225), so nothing is derived for them
 * and its own standalone events stay the single source. If a backend ever sends
 * both shapes, the observers absorb it: `tool_use` is keyed by id, and the
 * second `tool_result` for the same id finds the pending entry already consumed.
 */

import type { ClaudeEvent } from '../../claude/cli.js';

/** The block shapes we care about, across both message kinds. */
interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

/**
 * Content blocks of an event's message, or [] when it carries none.
 * String content is a text-only message (the shape we send our own follow-ups
 * in) — there is nothing to derive from it.
 */
function contentBlocks(event: ClaudeEvent): ContentBlock[] {
  const message = event.message as { content?: unknown } | undefined;
  const content = message?.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

/**
 * Standalone tool events implied by a block-carrying event. Empty for anything
 * else, so callers can fan out unconditionally.
 */
export function deriveToolEvents(event: ClaudeEvent): ClaudeEvent[] {
  if (event.type === 'assistant') {
    return contentBlocks(event)
      .filter((block) => block.type === 'tool_use' && block.id && block.name)
      .map((block) => ({
        type: 'tool_use',
        tool_use: { id: block.id, name: block.name, input: block.input ?? {} },
      }));
  }

  if (event.type === 'user') {
    return contentBlocks(event)
      .filter((block) => block.type === 'tool_result' && block.tool_use_id)
      .map((block) => ({
        type: 'tool_result',
        // Normalized to a boolean: observers test this flag to decide whether a
        // delivery counted, and `undefined` vs `false` must not read differently.
        tool_result: {
          tool_use_id: block.tool_use_id,
          is_error: block.is_error === true,
          content: block.content,
        },
      }));
  }

  return [];
}
