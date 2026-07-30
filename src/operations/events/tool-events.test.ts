/**
 * Tests for tool-event normalization.
 *
 * The contract these pin down is a SHAPE the rest of the pipeline reads
 * (`tool_use.id/name/input`, `tool_result.tool_use_id/is_error`). Renaming a
 * field here blinds the arbiter, docs-ping and return-address silently — none of
 * them throws on a missing field, they just observe nothing.
 */

import { describe, test, expect } from 'bun:test';
import { deriveToolEvents } from './tool-events.js';

describe('deriveToolEvents', () => {
  test('derives one tool_use per tool_use block in a Claude assistant message', () => {
    const derived = deriveToolEvents({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'sending it over' },
          { type: 'tool_use', id: 'tu_1', name: 'mcp__claude-threads-mcp__send_to_teammate', input: { teammate: 'rocksteady' } },
          { type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/x' } },
        ],
      },
    });

    expect(derived).toHaveLength(2);
    expect(derived[0]).toEqual({
      type: 'tool_use',
      tool_use: { id: 'tu_1', name: 'mcp__claude-threads-mcp__send_to_teammate', input: { teammate: 'rocksteady' } },
    });
    expect(derived[1].tool_use).toMatchObject({ id: 'tu_2', name: 'Read' });
  });

  test('derives tool_result from a Claude user message, normalizing is_error', () => {
    const ok = deriveToolEvents({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'sent' }] },
    });
    expect(ok).toHaveLength(1);
    expect(ok[0]).toEqual({
      type: 'tool_result',
      tool_result: { tool_use_id: 'tu_1', is_error: false, content: 'sent' },
    });

    const failed = deriveToolEvents({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2', is_error: true, content: 'nope' }] },
    });
    expect(failed[0].tool_result).toMatchObject({ tool_use_id: 'tu_2', is_error: true });
  });

  test('ignores blocks that cannot be acted on', () => {
    // No id → the arbiter could not match a later result to it, and docs-ping
    // and the teammate observer bail on it anyway.
    expect(deriveToolEvents({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read' }] },
    })).toEqual([]);

    expect(deriveToolEvents({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'orphan' }] },
    })).toEqual([]);
  });

  test('derives nothing from string content or non-message events', () => {
    expect(deriveToolEvents({ type: 'user', message: { content: 'plain follow-up' } })).toEqual([]);
    expect(deriveToolEvents({ type: 'assistant', message: {} })).toEqual([]);
    expect(deriveToolEvents({ type: 'result', subtype: 'success' })).toEqual([]);
    expect(deriveToolEvents({ type: 'system', subtype: 'init' })).toEqual([]);
  });

  test('derives nothing from a Codex assistant event, which already sends standalone events', () => {
    // Codex puts only text/thinking in assistant messages (translator.ts:211-225).
    // If that ever changed, every Codex tool call would be observed twice.
    expect(deriveToolEvents({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'done' }, { type: 'thinking', thinking: 'hmm' }] },
    })).toEqual([]);
  });
});
