/**
 * Chain messages — every word the chain says, in one pure place.
 *
 * Separated from the executor so the wording is testable and reviewable without
 * a platform, and so the three audiences stay visibly different in tone:
 *
 * - our own agent gets an INSTRUCTION ("do it now"), because a reminder phrased
 *   as information gets acknowledged and not acted on;
 * - another bot gets a MENTION with the subject, because that mention is what
 *   wakes its session and it must be able to act from that one post alone;
 * - humans get a STATUS with who is stuck on what, because they are being asked
 *   to intervene, not to perform a step.
 */

import { partyLabel, type Expectation, type EscalationReason } from './types.js';

/** Minutes since a timestamp, floored at 1 — "0 мин" reads as a bug. */
function minutesSince(from: number, now: number): number {
  return Math.max(1, Math.round((now - from) / 60_000));
}

/** The subject, rendered for a post. Steps without one say so plainly. */
function subject(expectation: Expectation): string {
  return expectation.subject ?? 'этой задаче';
}

/** What our own agent is told to do. Imperative, one action, no explanations. */
export function agentNudge(expectation: Expectation): string {
  switch (expectation.kind) {
    case 'review_requested':
      return `[Arbiter] MR ${subject(expectation)} открыт, но ревью никто не запросил. `
        + `Позови ревьюера (${partyLabel(expectation.waiter)}) прямо сейчас — это одно действие, а не пункт в отчёте.`;
    case 'mr_approved':
      return `[Arbiter] Ты сообщил, что правок по ${subject(expectation)} нет, но апрува в GitLab на нём нет. `
        + `Поставь approve сейчас. Мерж не жми — мержит владелец.`;
    case 'review_handback':
      return `[Arbiter] Ревью по ${subject(expectation)} ты закончил, но ${partyLabel(expectation.waiter)} об этом не знает `
        + `— его сессия просыпается только на упоминание. Скажи ему одним сообщением, что ревью готово.`;
    case 'task_report':
      return `[Arbiter] Задача закончена, но ${partyLabel(expectation.waiter)}, который её просил, об этом не знает. `
        + `Напиши ему коротко: что сделано и где смотреть.`;
    case 'review_reply':
      // Our own agent never owns this one; kept exhaustive so a new kind cannot
      // slip through the switch and reach a user as "undefined".
      return `[Arbiter] По ${subject(expectation)} ждут твоего ответа. Ответь сейчас.`;
  }
}

/** What another bot is told. Must be actionable from this single post. */
export function botPing(expectation: Expectation, name: string, now: number): string {
  const waited = minutesSince(expectation.since, now);
  switch (expectation.kind) {
    case 'review_reply':
      return `@${name} жду ревью: ${subject(expectation)} — тишина ${waited} мин. Возьми, пожалуйста.`;
    case 'mr_approved':
      return `@${name} ревью по ${subject(expectation)} выглядит законченным, но апрува в GitLab нет. `
        + `Поставь approve, если чисто, или скажи, что нужны правки.`;
    case 'review_handback':
      return `@${name} ты закончил ревью ${subject(expectation)}, но заказчик ответа не получил. Скажи ему.`;
    case 'review_requested':
      return `@${name} по ${subject(expectation)} нужно ревью.`;
    case 'task_report':
      return `@${name} задача по ${subject(expectation)} закончена — сообщи заказчику.`;
  }
}

/** What people are told, and why they are being pulled in. */
export function humanEscalation(
  expectation: Expectation,
  mentions: string,
  reason: EscalationReason,
  now: number
): string {
  const owner = partyLabel(expectation.owner);
  const waited = minutesSince(expectation.since, now);
  const what = stepDescription(expectation);

  const why =
    reason === 'owner_stalled'
      ? `${owner} не может ответить (в треде видно упор в лимит) — напоминания бессмысленны`
      : reason === 'unreachable'
        ? `${owner} недостижим отсюда — сессии в этом канале он не держит`
        : `${owner} не отвечает уже ${waited} мин, напоминания исчерпаны`;

  return `${mentions} цепочка встала: ${what}.\n${why}.`;
}

/** One line naming the stuck step, shared by escalations and the !arbiter list. */
export function stepDescription(expectation: Expectation): string {
  const target = subject(expectation);
  switch (expectation.kind) {
    case 'review_requested': return `ревью по ${target} так и не запрошено`;
    case 'review_reply':     return `ревьюер не пришёл на ${target}`;
    case 'mr_approved':      return `на ${target} нет апрува`;
    case 'review_handback':  return `результат ревью ${target} не передан заказчику`;
    case 'task_report':      return `заказчику не сообщили, что задача (${target}) закончена`;
  }
}
