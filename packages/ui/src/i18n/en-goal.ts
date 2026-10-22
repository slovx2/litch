// English copy for goals: /goal in the composer, the row above it, the side panel “Goal” tab, and the
// replace confirmation. Merged into en.ts; zh-CN-goal.ts is the source of truth for the keys.
import type { Entry } from './types.ts'

export const enGoal = {
  'slash.goal': 'Set a goal: keeps working whenever idle until it is done',
  'side.tab.goal': 'Goal',
  'goal.status.active': 'Working on goal',
  'goal.status.paused': 'Goal paused',
  'goal.status.blocked': 'Goal blocked',
  'goal.status.usageLimited': 'Usage limit reached, goal stopped',
  'goal.status.budgetLimited': 'Budget used up, goal stopped',
  'goal.status.complete': 'Goal reached',
  'goal.reached': 'Goal reached · {time}',
  'goal.tokens': '{used} / {budget} tokens',
  'goal.spent': '{time} spent',
  'goal.time.s': '{n}s',
  'goal.time.m': '{m}m',
  'goal.time.h': '{h}h {m}m',
  'goal.time.d': '{d}d {h}h',
  'goal.pause': 'Pause goal',
  'goal.resume': 'Resume goal',
  'goal.clear': 'Clear goal',
  'goal.open': 'Show the goal on the right',
  'goal.close': 'Hide the goal',
  'goal.replace.title': 'Replace the goal?',
  'goal.replace.note':
    'The conversation stays. The current goal becomes what you just wrote: “{objective}”',
  'goal.replace.yes': 'Replace goal',
  'goal.replace.no': 'Keep it',
  'goal.replace.kept': 'The goal was not replaced; your text is back in the box',
  'goal.needText': 'Write what should get done after /goal',
  'goal.textOnly': 'A goal is text only. Send images and attachments after the goal is set',
  'goal.failed.set': 'Could not set the goal: {reason}',
  'goal.failed.update': 'Could not update the goal: {reason}',
  'goal.failed.clear': 'Could not clear the goal: {reason}',
  'goal.tab.pick': 'Open a conversation to see its goal here.',
  'goal.tab.unsupported': '{harness} does not support goals.',
  'goal.tab.none':
    'This conversation has no goal. Type /goal followed by what should get done: it keeps going round after round until it is done, blocked, or you stop it.',
  'goal.tab.objective': 'Goal',
  'goal.tab.save': 'Save',
  'goal.tab.revert': 'Revert',
  'goal.tab.updated': 'Updated {ago}',
  'goal.tab.status': 'Status',
  'goal.tab.time': 'Time',
  'goal.tab.tokens': 'Tokens used',
  'goal.tab.budget': 'Budget',
  'goal.tab.noBudget': 'None',
  'goal.tab.saveHint': 'Changes take effect when saved. {key} to save',
  'goal.tab.note.active':
    'Whenever a round ends and the conversation is idle, it starts the next round. Stopping pauses the goal first.',
  'goal.tab.note.paused':
    'Paused: it will not continue on its own. Resume to keep going when idle.',
  'goal.tab.note.blocked':
    'The model hit something it could not get past, or a round failed. Check the reason in the conversation, fix it, then resume.',
  'goal.tab.note.usageLimited': 'The account reached its usage limit. Resume once it resets.',
  'goal.tab.note.budgetLimited':
    'The token budget for this goal is used up, so it stopped. Set a new goal or clear this one.',
  'goal.tab.note.complete':
    'The model checked every requirement: the goal is reached. Clear it or write a new one.',
} satisfies Record<string, Entry>
