import type { Entry } from './types.ts'
export const enModelRanking = {
  'ranking.choose': 'Use {model} for this start',
  'ranking.title': 'Model ranking',
  'ranking.open': 'Manage ranks',
  'ranking.builtin': 'Built-in ranking: compare within each harness',
  'ranking.custom': 'Custom ranking: compare across all harnesses',
  'ranking.note':
    'Higher ranks appear first. Models in the same group are equal. Drag a model or choose a rank. Saving custom ranking also limits delegation across harnesses.',
  'ranking.unknownNote':
    'Unranked models may only inherit the parent’s identity. Assign a rank before switching models, or explicitly select one on the proposal card.',
  'ranking.unranked': 'Unranked',
  'ranking.level': 'Rank {level}',
  'ranking.new': 'Separate rank (highest)',
  'ranking.save': 'Save custom ranking',
  'ranking.reset': 'Restore built-in ranking',
  'ranking.resetNote':
    'Clear custom ranking. Delegation across harnesses will no longer compare ranks.',
  'ranking.refresh': 'Reload',
  'ranking.unavailable': 'Unavailable',
  'ranking.partial': 'Some models could not be read',
  'ranking.unsaved': 'Unsaved changes',
  'ranking.loading': 'Loading models',
  'ranking.close': 'Close',
  'ranking.cancel': 'Cancel',
  'ranking.move': 'Move model',
} satisfies Record<string, Entry>
