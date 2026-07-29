/**
 * Tests for Event Transformer
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { transformEvent, type TransformContext } from './transformer.js';
import type { ClaudeEvent } from '../claude/cli.js';
import type { PlatformFormatter } from '../platform/formatter.js';

// Mock formatter
const mockFormatter: PlatformFormatter = {
  formatBold: (text: string) => `**${text}**`,
  formatItalic: (text: string) => `_${text}_`,
  formatCode: (text: string) => `\`${text}\``,
  formatCodeBlock: (text: string, lang?: string) =>
    lang ? `\`\`\`${lang}\n${text}\n\`\`\`` : `\`\`\`\n${text}\n\`\`\``,
  formatLink: (text: string, url: string) => `[${text}](${url})`,
  formatStrikethrough: (text: string) => `~~${text}~~`,
  formatMarkdown: (text: string) => text,
  formatUserMention: (userId: string) => `@${userId}`,
  formatHorizontalRule: () => '---',
  formatBlockquote: (text: string) => `> ${text}`,
  formatListItem: (text: string) => `- ${text}`,
  formatNumberedListItem: (n: number, text: string) => `${n}. ${text}`,
  formatHeading: (text: string, level: number) => `${'#'.repeat(level)} ${text}`,
  escapeText: (text: string) => text,
  formatTable: (_headers: string[], _rows: string[][]) => '',
  formatKeyValueList: (_items: [string, string, string][]) => '',
};

describe('Event Transformer', () => {
  let ctx: TransformContext;

  beforeEach(() => {
    ctx = {
      sessionId: 'test-session',
      formatter: mockFormatter,
      toolStartTimes: new Map(),
      detailed: true,
    };
  });

  // ---------------------------------------------------------------------------
  // Rolling tool line
  // ---------------------------------------------------------------------------

  describe('rolling tool line', () => {
    const bashUse: ClaudeEvent = {
      type: 'tool_use',
      tool_use: { id: 't1', name: 'Bash', input: { command: 'cd ~/workspaces/wd/smart-blocks && npm run check' } },
    } as ClaudeEvent;
    const bashResult: ClaudeEvent = {
      type: 'tool_result',
      tool_result: { tool_use_id: 't1' },
    } as ClaudeEvent;

    it('opens a rolling line for Bash and folds its result into it', () => {
      ctx.toolGroups = new Map();

      const [useOp] = transformEvent(bashUse, ctx) as any[];
      expect(useOp.toolGroup).toEqual({
        key: 'inspect', role: 'start', prefix: '💻 **Bash**', body: '`npm run check`',
      });

      const [resultOp] = transformEvent(bashResult, ctx) as any[];
      expect(resultOp.toolGroup).toEqual({ key: 'inspect', role: 'result', status: '✓' });
      // The `↳` line is what the status replaces.
      expect(resultOp.content).toBe('');
      expect(ctx.toolGroups!.size).toBe(0);
    });

    it('keeps the classic two-line rendering when grouping is not wired up', () => {
      const [useOp] = transformEvent(bashUse, ctx) as any[];
      expect(useOp.toolGroup).toBeUndefined();

      const [resultOp] = transformEvent(bashResult, ctx) as any[];
      expect(resultOp.toolGroup).toBeUndefined();
      expect(resultOp.content).toBe('  ↳ ✓');
    });

    it('leaves a diff-bearing tool on its own line', () => {
      ctx.toolGroups = new Map();
      const [useOp] = transformEvent({
        type: 'tool_use',
        tool_use: { id: 't2', name: 'Write', input: { file_path: '/tmp/a.ts', content: 'x' } },
      } as ClaudeEvent, ctx) as any[];

      expect(useOp.toolGroup).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Assistant Events
  // ---------------------------------------------------------------------------

  describe('assistant events', () => {
    it('transforms text content', () => {
      const event: ClaudeEvent = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello, world!' }],
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('append_content');
      expect((ops[0] as { content: string }).content).toBe('Hello, world!');
    });

    it('filters out thinking tags', () => {
      const event: ClaudeEvent = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello <thinking>internal thought</thinking> world!' }],
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect((ops[0] as { content: string }).content).toBe('Hello  world!');
    });

    it('transforms tool_use in assistant message', () => {
      const event: ClaudeEvent = {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', id: 'tool1', input: { file_path: '/test/file.ts' } },
          ],
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('append_content');
      expect((ops[0] as { content: string }).content).toContain('Read');
    });

    it('handles thinking blocks', () => {
      const event: ClaudeEvent = {
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Let me think about this problem...' }],
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect((ops[0] as { content: string }).content).toContain('💭');
      expect((ops[0] as { content: string }).content).toContain('think');
    });

    it('returns empty for empty content', () => {
      const event: ClaudeEvent = {
        type: 'assistant',
        message: { content: [] },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Tool Use Events
  // ---------------------------------------------------------------------------

  describe('tool_use events', () => {
    it('transforms Read tool', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: { id: 'tool1', name: 'Read', input: { file_path: '/path/file.ts' } },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('append_content');
      expect((ops[0] as { content: string }).content).toContain('Read');
    });

    it('transforms Bash tool', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: { id: 'tool1', name: 'Bash', input: { command: 'ls -la' } },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect((ops[0] as { content: string }).content).toContain('Bash');
      expect((ops[0] as { content: string }).content).toContain('ls');
    });

    it('tracks tool start time', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: { id: 'tool123', name: 'Read', input: {} },
      };

      transformEvent(event, ctx);

      expect(ctx.toolStartTimes.has('tool123')).toBe(true);
    });

    it('handles TodoWrite specially', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'tool1',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Task 1', status: 'pending', activeForm: 'Doing task 1' },
            ],
          },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('task_list');
    });

    it('handles Task specially', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'tool1',
          name: 'Task',
          input: { description: 'Search codebase', subagent_type: 'Explore' },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('subagent');
      expect((ops[0] as { action: string }).action).toBe('start');
    });

    it('handles AskUserQuestion specially', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'tool1',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                header: 'Choice',
                question: 'Which option?',
                options: [
                  { label: 'Option A', description: 'First option' },
                  { label: 'Option B', description: 'Second option' },
                ],
              },
            ],
          },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('question');
      expect((ops[0] as { questions: unknown[] }).questions.length).toBe(1);
    });

    it('handles ExitPlanMode specially', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: { id: 'tool1', name: 'ExitPlanMode', input: {} },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('approval');
      expect((ops[0] as { approvalType: string }).approvalType).toBe('plan');
    });
  });

  // ---------------------------------------------------------------------------
  // Tool Result Events
  // ---------------------------------------------------------------------------

  describe('tool_result events', () => {
    it('transforms success result', () => {
      const event: ClaudeEvent = {
        type: 'tool_result',
        tool_result: { tool_use_id: 'tool1', is_error: false },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(2);
      expect(ops[0].type).toBe('append_content');
      expect((ops[0] as { content: string }).content).toContain('✓');
      expect(ops[1].type).toBe('flush');
    });

    it('transforms error result', () => {
      const event: ClaudeEvent = {
        type: 'tool_result',
        tool_result: { tool_use_id: 'tool1', is_error: true },
      };

      const ops = transformEvent(event, ctx);

      expect(ops[0].type).toBe('append_content');
      expect((ops[0] as { content: string }).content).toContain('❌');
      expect((ops[0] as { content: string }).content).toContain('Error');
    });

    it('includes elapsed time for long-running tools', () => {
      // Simulate tool started 5 seconds ago
      ctx.toolStartTimes.set('tool1', Date.now() - 5000);

      const event: ClaudeEvent = {
        type: 'tool_result',
        tool_result: { tool_use_id: 'tool1', is_error: false },
      };

      const ops = transformEvent(event, ctx);

      expect((ops[0] as { content: string }).content).toContain('5s');
    });

    it('does not include elapsed time for quick tools', () => {
      // Simulate tool started 1 second ago
      ctx.toolStartTimes.set('tool1', Date.now() - 1000);

      const event: ClaudeEvent = {
        type: 'tool_result',
        tool_result: { tool_use_id: 'tool1', is_error: false },
      };

      const ops = transformEvent(event, ctx);

      expect((ops[0] as { content: string }).content).not.toContain('s)');
    });

    it('cleans up tool start time', () => {
      ctx.toolStartTimes.set('tool1', Date.now());

      const event: ClaudeEvent = {
        type: 'tool_result',
        tool_result: { tool_use_id: 'tool1', is_error: false },
      };

      transformEvent(event, ctx);

      expect(ctx.toolStartTimes.has('tool1')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Result Events
  // ---------------------------------------------------------------------------

  describe('result events', () => {
    it('creates flush operation', () => {
      const event: ClaudeEvent = {
        type: 'result',
        result: {},
      };

      const ops = transformEvent(event, ctx);

      expect(ops.some(op => op.type === 'flush')).toBe(true);
    });

    it('creates status update with usage stats', () => {
      const event: ClaudeEvent = {
        type: 'result',
        result: {
          model: 'claude-opus-4-5',
          cost_usd: 0.05,
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
          },
        },
      };

      const ops = transformEvent(event, ctx);

      const statusOp = ops.find(op => op.type === 'status_update');
      expect(statusOp).toBeDefined();
      expect((statusOp as { modelId: string }).modelId).toBe('claude-opus-4-5');
      expect((statusOp as { totalCostUSD: number }).totalCostUSD).toBe(0.05);
    });

    /**
     * Regression test: StatusUpdateOp must ALWAYS be created when Claude's turn ends.
     * This is critical because StatusUpdateOp triggers finalize() to clean up orphaned task lists.
     *
     * Bug: Previously, StatusUpdateOp was only created if result.result existed.
     * If Claude's result event didn't have that property, finalize() was never called,
     * leaving orphaned task lists visible to users.
     */
    it('ALWAYS creates status update even when result.result is missing', () => {
      // This simulates a result event without the result property
      const event: ClaudeEvent = {
        type: 'result',
        // No 'result' property - this used to cause StatusUpdateOp to not be created
      };

      const ops = transformEvent(event, ctx);

      // CRITICAL: StatusUpdateOp must be created to trigger finalize()
      const statusOp = ops.find(op => op.type === 'status_update');
      expect(statusOp).toBeDefined();
    });

    it('ALWAYS creates status update even when result.result is empty', () => {
      const event: ClaudeEvent = {
        type: 'result',
        result: {}, // Empty result object
      };

      const ops = transformEvent(event, ctx);

      const statusOp = ops.find(op => op.type === 'status_update');
      expect(statusOp).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Special Tools
  // ---------------------------------------------------------------------------

  describe('TodoWrite handling', () => {
    it('creates task list operation with tasks', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'tool1',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Task 1', status: 'completed', activeForm: 'Completing task 1' },
              { content: 'Task 2', status: 'in_progress', activeForm: 'Working on task 2' },
              { content: 'Task 3', status: 'pending', activeForm: 'Planning task 3' },
            ],
          },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('task_list');
      const taskOp = ops[0] as { action: string; tasks: unknown[] };
      expect(taskOp.action).toBe('update');
      expect(taskOp.tasks.length).toBe(3);
    });

    it('sets action to complete when all tasks done', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'tool1',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Task 1', status: 'completed', activeForm: 'Done' },
              { content: 'Task 2', status: 'completed', activeForm: 'Done' },
            ],
          },
        },
      };

      const ops = transformEvent(event, ctx);

      expect((ops[0] as { action: string }).action).toBe('complete');
    });
  });

  describe('Task (subagent) handling', () => {
    it('creates subagent start operation', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'subagent-123',
          name: 'Task',
          input: {
            description: 'Search for authentication code',
            subagent_type: 'Explore',
          },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('subagent');
      const subOp = ops[0] as {
        toolUseId: string;
        action: string;
        description: string;
        subagentType: string;
      };
      expect(subOp.toolUseId).toBe('subagent-123');
      expect(subOp.action).toBe('start');
      expect(subOp.description).toBe('Search for authentication code');
      expect(subOp.subagentType).toBe('Explore');
    });

    it('uses prompt field if description missing', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'tool1',
          name: 'Task',
          input: { prompt: 'Do something' },
        },
      };

      const ops = transformEvent(event, ctx);

      expect((ops[0] as { description: string }).description).toBe('Do something');
    });

    /**
     * Claude CLI renamed the tool `Task` → `Agent`. Under the old name only, an
     * agent launch fell through to the generic `● **Agent**` content line, which
     * both lost the subagent post and ended the rolling tool line — so a fan-out
     * of agents shattered one `💻 Bash ×40` into a line per burst.
     */
    it('treats the renamed Agent tool as a subagent launch', () => {
      const ops = transformEvent({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'agent-1',
            name: 'Agent',
            input: { description: 'Review MR 88', subagent_type: 'pw-gitlab-code-reviewer' },
          }],
        },
      } as ClaudeEvent, ctx);

      expect(ops.map(op => op.type)).toEqual(['subagent']);
      const subOp = ops[0] as { toolUseId: string; action: string; subagentType: string };
      expect(subOp.toolUseId).toBe('agent-1');
      expect(subOp.action).toBe('start');
      expect(subOp.subagentType).toBe('pw-gitlab-code-reviewer');
    });

    it('registers a foreground launch for completion, a background one not', () => {
      ctx.subagents = new Map();

      const launch = (id: string, background: boolean): ClaudeEvent => ({
        type: 'tool_use',
        tool_use: {
          id,
          name: 'Agent',
          input: { description: 'Sweep', subagent_type: 'Explore', run_in_background: background },
        },
      } as ClaudeEvent);

      const [fg] = transformEvent(launch('fg', false), ctx) as Array<{ isBackground?: boolean }>;
      const [bg] = transformEvent(launch('bg', true), ctx) as Array<{ isBackground?: boolean }>;

      expect(fg.isBackground).toBe(false);
      expect(bg.isBackground).toBe(true);
      expect([...ctx.subagents.keys()]).toEqual(['fg']);
    });
  });

  // ---------------------------------------------------------------------------
  // Tool outcomes carried by `user` messages (how Claude CLI reports them)
  // ---------------------------------------------------------------------------

  describe('user events', () => {
    function toolResult(toolUseId: string, isError?: boolean): ClaudeEvent {
      return {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError }] },
      } as ClaudeEvent;
    }

    /**
     * Claude CLI never emits the `tool_result` events the Codex backend does, so
     * this used to fall through to `default: []` — leaving every rolling line
     * stuck on ⏳ for the rest of the session.
     */
    it('stamps a rolling line with the outcome of its tool', () => {
      ctx.toolGroups = new Map();
      transformEvent({
        type: 'tool_use',
        tool_use: { id: 't1', name: 'Bash', input: { command: 'npm test' } },
      } as ClaudeEvent, ctx);

      const ops = transformEvent(toolResult('t1'), ctx) as Array<{ toolGroup?: unknown }>;

      expect(ops.length).toBe(1);
      expect(ops[0].toolGroup).toEqual({ key: 'inspect', role: 'result', status: '✓' });
      expect(ctx.toolGroups.size).toBe(0);
    });

    it('reports a failed tool as an error on the same line', () => {
      ctx.toolGroups = new Map();
      transformEvent({
        type: 'tool_use',
        tool_use: { id: 't1', name: 'Bash', input: { command: 'npm test' } },
      } as ClaudeEvent, ctx);

      const [op] = transformEvent(toolResult('t1', true), ctx) as Array<{ toolGroup?: { status: string } }>;

      expect(op.toolGroup?.status).toBe('❌ Error');
    });

    /**
     * A `↳ ✓` under every Edit, Write and MCP call is the wall of lines the
     * rolling line exists to remove, so ungrouped tools stay silent here.
     */
    it('adds no result line for a tool without a rolling line', () => {
      ctx.toolGroups = new Map();
      transformEvent({
        type: 'tool_use',
        tool_use: { id: 't2', name: 'Write', input: { file_path: '/tmp/a.ts', content: 'x' } },
      } as ClaudeEvent, ctx);

      expect(transformEvent(toolResult('t2'), ctx)).toEqual([]);
    });

    it('closes the post of the subagent whose result came back', () => {
      ctx.subagents = new Map();
      transformEvent({
        type: 'tool_use',
        tool_use: { id: 'agent-1', name: 'Agent', input: { description: 'Sweep', subagent_type: 'Explore' } },
      } as ClaudeEvent, ctx);

      const ops = transformEvent(toolResult('agent-1'), ctx);

      expect(ops.map(op => op.type)).toEqual(['subagent']);
      expect((ops[0] as { action: string; description: string }).action).toBe('complete');
      expect((ops[0] as { description: string }).description).toBe('Sweep');
      expect(ctx.subagents.size).toBe(0);
    });

    it('leaves a background launch open — its ack is not a completion', () => {
      ctx.subagents = new Map();
      transformEvent({
        type: 'tool_use',
        tool_use: {
          id: 'agent-bg',
          name: 'Agent',
          input: { description: 'Sweep', subagent_type: 'Explore', run_in_background: true },
        },
      } as ClaudeEvent, ctx);

      expect(transformEvent(toolResult('agent-bg'), ctx)).toEqual([]);
    });

    it('ignores user messages that carry no tool results', () => {
      expect(transformEvent({
        type: 'user',
        message: { content: [{ type: 'text', text: 'Base directory for this skill: /skills/foo' }] },
      } as ClaudeEvent, ctx)).toEqual([]);

      expect(transformEvent({
        type: 'user',
        message: { content: 'plain reply from the user' },
      } as ClaudeEvent, ctx)).toEqual([]);
    });
  });

  describe('AskUserQuestion handling', () => {
    it('creates question operation with all fields', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'q-123',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                header: 'Framework',
                question: 'Which framework should we use?',
                options: [
                  { label: 'React', description: 'Popular UI library' },
                  { label: 'Vue', description: 'Progressive framework' },
                ],
                multiSelect: false,
              },
            ],
          },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('question');
      const qOp = ops[0] as {
        toolUseId: string;
        questions: Array<{
          header: string;
          question: string;
          options: Array<{ label: string; description: string }>;
          multiSelect: boolean;
        }>;
        currentIndex: number;
      };
      expect(qOp.toolUseId).toBe('q-123');
      expect(qOp.questions.length).toBe(1);
      expect(qOp.questions[0].header).toBe('Framework');
      expect(qOp.questions[0].options.length).toBe(2);
      expect(qOp.currentIndex).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Permission Requests (Codex approvals)
  // ---------------------------------------------------------------------------

  describe('permission_request events (Codex approvals)', () => {
    it('creates an action approval with the allow-all option', () => {
      const event: ClaudeEvent = {
        type: 'permission_request',
        permission_request: {
          tool_use_id: 'codex-perm:42',
          name: 'Bash',
          input: { command: 'rm -rf build' },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops).toHaveLength(1);
      expect(ops[0].type).toBe('approval');
      const approval = ops[0] as { approvalType: string; toolUseId: string; allowSession?: boolean; content?: string };
      expect(approval.approvalType).toBe('action');
      expect(approval.toolUseId).toBe('codex-perm:42');
      expect(approval.allowSession).toBe(true);
      expect(approval.content).toContain('rm -rf build');
    });

    it('ignores malformed permission_request events', () => {
      const event: ClaudeEvent = { type: 'permission_request' };
      expect(transformEvent(event, ctx)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown Events
  // ---------------------------------------------------------------------------

  describe('unknown events', () => {
    it('returns empty array for unknown event types', () => {
      const event: ClaudeEvent = {
        type: 'unknown_event_type',
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(0);
    });
  });
});
