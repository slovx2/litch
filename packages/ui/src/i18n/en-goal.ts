// English copy for goals: /goal in the composer, the row above it, the side panel “Goal” tab, and the
// replace confirmation. Merged into en.ts; zh-CN-goal.ts is the source of truth for the keys.
import type { Entry } from './types.ts'

export const enGoal = {
  'slash.goal': 'Set a goal: keeps working whenever idle until done',
  'side.tab.goal': 'Goal',
  'goal.status.active': 'Working on goal',
  'goal.status.paused': 'Goal paused',
  'goal.status.blocked': 'Goal blocked',
  'goal.status.usageLimited': 'Usage limit reached, goal stopped',
  'goal.status.budgetLimited': 'Budget used up, goal stopped',
  'goal.status.complete': 'Goal reached',
  'goal.tokens': '{used} / {budget} tokens',
  'goal.spent': '{time} spent',
  'goal.time.s': '{n}s',
  'goal.time.m': '{m}m',
  'goal.time.h': '{h}h {m}m',
  'goal.time.d': '{d}d {h}h',
  'goal.pause': 'Pause goal',
  'goal.resume': 'Resume goal',
  'goal.clear': 'Clear goal',
  'goal.open': 'Show goal on the right',
  'goal.close': 'Hide goal',
  'goal.replace.title': 'Replace the goal?',
  'goal.replace.note':
    'The conversation stays. The current goal will be replaced with: “{objective}”',
  'goal.replace.yes': 'Replace goal',
  'goal.replace.no': 'Keep current',
  'goal.replace.kept': 'Goal not replaced. Your text is back in the composer.',
  'goal.needText': 'Enter the goal after /goal',
  'goal.textOnly': 'Goals are text only. Send images and attachments after setting the goal.',
  'goal.failed.set': 'Couldn’t set the goal: {reason}',
  'goal.failed.update': 'Couldn’t update the goal: {reason}',
  'goal.failed.clear': 'Couldn’t clear the goal: {reason}',
  'goal.tab.pick': 'Open a conversation to see its goal.',
  'goal.tab.unsupported': '{harness} doesn’t support goals.',
  'goal.tab.none':
    'No goal in this conversation. Type /goal followed by the goal; the model keeps working round after round until it’s done, blocked, or stopped.',
  'goal.tab.objective': 'Goal',
  'goal.tab.save': 'Save',
  'goal.tab.revert': 'Revert',
  'goal.tab.updated': 'Updated {ago}',
  'goal.tab.status': 'Status',
  'goal.tab.time': 'Time',
  'goal.tab.tokens': 'Tokens used',
  'goal.tab.budget': 'Budget',
  'goal.tab.noBudget': 'None',
  'goal.tab.saveHint': 'Save to apply changes. {key} to save',
  'goal.tab.note.active':
    'Starts the next round whenever a round ends and the conversation is idle. Stopping pauses the goal first.',
  'goal.tab.note.paused': 'Paused. Resume to continue when idle.',
  'goal.tab.note.blocked':
    'The model hit something it couldn’t resolve, or a round failed. Check the conversation, fix the issue, then resume.',
  'goal.tab.note.usageLimited': 'The account reached its usage limit. Resume once it resets.',
  'goal.tab.note.budgetLimited':
    'The token budget for this goal is used up. Set a new goal or clear this one.',
  'goal.tab.note.complete':
    'The model checked every requirement and the goal is reached. Clear it or set a new one.',
} satisfies Record<string, Entry>
