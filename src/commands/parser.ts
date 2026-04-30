/**
 * Command Parser Module
 *
 * Shared command parsing logic for both user messages and Claude output.
 * Centralizes the definition of available commands and their parsing.
 */

import { buildClaudeAllowedCommandsSet } from './registry.js';

// =============================================================================
// Command Definitions
// =============================================================================

/**
 * Parsed command result
 */
export interface ParsedCommand {
  /** The command name (without !) */
  command: string;
  /** Arguments for the command */
  args?: string;
  /** The full match string (for removal from text) */
  match: string;
}

/**
 * Extended parsed command with remainder text for stacking.
 */
export interface ParsedCommandWithRemainder extends ParsedCommand {
  /** Text after the command (for first-message stacking) */
  remainder?: string;
}

/**
 * Commands that Claude is allowed to execute from its output.
 * Only safe commands that don't modify access control or security settings.
 *
 * This is derived from the unified command registry where commands have
 * `claudeCanExecute: true` set.
 *
 * Commands marked with `returnsResultToClaude: true` will have their output
 * sent back to Claude in a <command-result> tag.
 */
export const CLAUDE_ALLOWED_COMMANDS = buildClaudeAllowedCommandsSet();

/**
 * All available commands and their patterns.
 * Each entry is [command, pattern] where pattern captures optional args.
 */
const COMMAND_PATTERNS: Array<[string, RegExp]> = [
  // Session control
  ['stop', /^!(?:stop|cancel)\s*$/i],
  ['escape', /^!(?:escape|interrupt)\s*$/i],
  ['approve', /^!(?:approve|yes)\s*$/i],
  ['help', /^!help\s*$/i],
  ['release-notes', /^!(?:release-notes|changelog)\s*$/i],

  // Directory/worktree
  ['cd', /^!cd\s+(.+)$/i],
  ['worktree', /^!worktree\s+(\S+(?:\s+.*)?)$/i],

  // User management
  ['invite', /^!invite\s+@?([\w.-]+)\s*$/i],
  ['kick', /^!kick\s+@?([\w.-]+)\s*$/i],

  // Permissions — accepts the canonical modes (default|auto|bypass) plus the
  // legacy `interactive` (→ default) and `skip` (→ bypass) aliases.
  ['permissions', /^!permissions?\s+(default|auto|bypass|interactive|skip)\s*$/i],

  // Updates
  ['update', /^!update(?:\s+(now|defer))?\s*$/i],

  // Claude Code passthrough commands
  ['context', /^!context\s*$/i],
  ['cost', /^!cost\s*$/i],
  ['compact', /^!compact\s*$/i],

  // Plugin management
  ['plugin', /^!plugin(?:\s+(.+))?$/i],

  // Emergency
  ['kill', /^!kill\s*$/i],

  // Bug reporting
  ['bug', /^!bug(?:\s+(.+))?$/i],

  // Catch-all for dynamic slash commands (checked last)
  // Matches any !word or !word args pattern that wasn't caught above
  // The handler will verify if it's a valid slash command from init event
  ['_dynamic', /^!([a-z][-a-z0-9]*)(?:\s+(.+))?$/i],
];

// =============================================================================
// Parser Functions
// =============================================================================

/**
 * Parse a command from text content.
 *
 * @param text - The text to parse (should be trimmed)
 * @returns Parsed command or null if no command found
 */
export function parseCommand(text: string): ParsedCommand | null {
  for (const [command, pattern] of COMMAND_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      // Special handling for _dynamic pattern - extract actual command name
      if (command === '_dynamic') {
        return {
          command: match[1].toLowerCase(),  // The actual command name (e.g., 'review')
          args: match[2]?.trim(),            // The actual args (e.g., '--detailed')
          match: match[0],
        };
      }
      return {
        command,
        args: match[1]?.trim(),
        match: match[0],
      };
    }
  }
  return null;
}

/**
 * Parse a command from Claude's assistant output.
 * Uses multiline matching since the command may be in the middle of text.
 *
 * Only returns commands that Claude is allowed to execute.
 *
 * @param text - The full assistant text output
 * @returns Parsed command or null if no allowed command found
 */
export function parseClaudeCommand(text: string): ParsedCommand | null {
  // For Claude output, we only allow specific commands
  // and they must be on their own line

  // Check for !cd command
  const cdMatch = text.match(/^!cd\s+([\w~./-]+)\s*$/m);
  if (cdMatch && CLAUDE_ALLOWED_COMMANDS.has('cd')) {
    return {
      command: 'cd',
      args: cdMatch[1],
      match: cdMatch[0].trimEnd(),  // Remove trailing whitespace/newline
    };
  }

  // Check for !worktree list command
  const worktreeListMatch = text.match(/^!worktree\s+list\s*$/m);
  if (worktreeListMatch && CLAUDE_ALLOWED_COMMANDS.has('worktree list')) {
    return {
      command: 'worktree list',
      args: undefined,
      match: worktreeListMatch[0].trimEnd(),
    };
  }

  // Check for !attach command. Two accepted shapes:
  //   !attach output.xlsx              — path with no whitespace
  //   !attach "Q1 report.xlsx"         — path with whitespace, quoted
  //   !attach 'Q1 report.xlsx'         — single-quoted variant
  //
  // [ \t]+ rather than \s+ between command and arg: \s also matches \n, so
  // `!attach\nsomething` would have matched and the bot would happily upload
  // whatever came on the next line. Same for trailing — only spaces and tabs
  // count as in-line whitespace.
  // `[^"\r\n]+` and `[^'\r\n]+` reject embedded \r so a CRLF input on Windows
  // doesn't capture a stray \r into the filename and ENOENT on lookup.
  const attachMatch = text.match(/^!attach[ \t]+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))[ \t]*$/m);
  if (attachMatch && CLAUDE_ALLOWED_COMMANDS.has('attach')) {
    const path = attachMatch[1] ?? attachMatch[2] ?? attachMatch[3];
    return {
      command: 'attach',
      args: path,
      match: attachMatch[0].trimEnd(),
    };
  }

  // Check for !bug command
  const bugMatch = text.match(/^!bug\s+(.+)$/m);
  if (bugMatch && CLAUDE_ALLOWED_COMMANDS.has('bug')) {
    return {
      command: 'bug',
      args: bugMatch[1].trim(),
      match: bugMatch[0].trimEnd(),
    };
  }

  return null;
}

/**
 * Check if a command is allowed to be executed by Claude.
 */
export function isClaudeAllowedCommand(command: string): boolean {
  return CLAUDE_ALLOWED_COMMANDS.has(command);
}

/**
 * Remove a command from text (for cleaning up display).
 *
 * Strips ONLY a line-anchored occurrence of `command.match`, not the first
 * textual one. The parser uses multiline-anchored regexes (`^…$/m`), so the
 * occurrence it actually matched is always on its own line. A plain
 * `text.replace(match, '')` would remove the *first* substring match,
 * which can be an unrelated inline mention of the same string — e.g.
 *
 *     Use !attach foo.xlsx like this.    ← inline mention
 *     !attach foo.xlsx                   ← actual command
 *
 * Without line-anchoring, iteration 1 would strip the inline mention,
 * leave the line-anchored command intact, and iteration 2 of the parser
 * loop would re-parse and re-fire the command, double-uploading the file.
 *
 * @param text - Original text
 * @param command - The parsed command to remove
 * @returns Text with command removed and trimmed
 */
export function removeCommandFromText(text: string, command: ParsedCommand): string {
  const escaped = command.match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the command as a complete line: nothing significant before it on
  // the line, optional trailing whitespace, end-of-line. The /m flag is
  // what makes `^` and `$` line-anchored rather than string-anchored.
  const lineRe = new RegExp(`^${escaped}[ \\t]*$`, 'm');
  return text.replace(lineRe, '').trim();
}

// =============================================================================
// First-Message Command Parsing (with stacking support)
// =============================================================================

/**
 * Patterns for stackable first-message commands.
 * These extract the command argument AND the remaining text for stacking.
 *
 * Pattern format: [command, regex, argGroup, remainderGroup]
 * - argGroup: which capture group contains the command argument
 * - remainderGroup: which capture group contains the remaining text
 */
const STACKABLE_PATTERNS: Array<[string, RegExp, number, number]> = [
  // !cd <path> [remainder]
  ['cd', /^!cd\s+(\S+)(?:\s+(.*))?$/i, 1, 2],
  // !permissions <mode> [remainder]. Accepts all canonical and legacy modes.
  ['permissions', /^!permissions?\s+(default|auto|bypass|interactive|skip)(?:\s+(.*))?$/i, 1, 2],
  // !worktree - capture everything after !worktree as args
  // The executor will parse subcommand vs branch from the args
  ['worktree', /^!worktree\s+(.+)$/i, 1, -1],  // -1 means no remainder group
];

/**
 * Patterns for immediate first-message commands (no stacking, return immediately).
 */
const IMMEDIATE_PATTERNS: Array<[string, RegExp]> = [
  ['help', /^!help\s*$/i],
  ['release-notes', /^!(?:release-notes|changelog)\s*$/i],
  ['update', /^!update\s*$/i],
];

/**
 * Parse a command from first-message text, supporting stacking.
 *
 * For stackable commands like !cd and !permissions, extracts the command
 * argument and returns the remaining text for further processing.
 *
 * For immediate commands like !help, returns no remainder (command handles everything).
 *
 * @param text - The text to parse (should be trimmed)
 * @returns Parsed command with remainder, or null if no command found
 */
export function parseCommandWithRemainder(text: string): ParsedCommandWithRemainder | null {
  // Try immediate patterns first
  for (const [command, pattern] of IMMEDIATE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return {
        command,
        args: undefined,
        match: match[0],
        remainder: undefined,
      };
    }
  }

  // Try stackable patterns
  for (const [command, pattern, argGroup, remainderGroup] of STACKABLE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return {
        command,
        args: match[argGroup]?.trim(),
        match: match[0],
        // -1 means no remainder group
        remainder: remainderGroup >= 0 ? (match[remainderGroup]?.trim() || undefined) : undefined,
      };
    }
  }

  return null;
}
