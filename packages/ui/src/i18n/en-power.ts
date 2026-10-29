import type { Entry } from './types.ts'

export const enPower = {
  'power.quick.name': 'Always prevent sleep when plugged in',
  'power.quick.on': 'Always-on enabled',
  'power.quick.off': 'Always-on disabled',
  'power.quick.wait': 'Enabled; waiting for external power',
  'power.quick.energy':
    'Preventing idle system sleep uses more energy. The screen can still turn off or lock.',
  'power.source.ac': 'Plugged in',
  'power.source.battery': 'On battery',
  'power.source.unknown': 'Power source unknown',
  'power.quick.failed': 'Could not change power settings: {reason}',
} satisfies Record<string, Entry>
