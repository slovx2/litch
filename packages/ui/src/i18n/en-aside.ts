// English copy for side chats: the side panel “Side chat” tab, the buttons on the selection toolbar, and the
// close / new side chat confirmations. Merged into en.ts; zh-CN-aside.ts is the source of truth for the keys.
import type { Entry } from './types.ts'

export const enAside = {
  'side.tab.aside': 'Side chat',
  'aside.intro':
    'Ask something on the side. A side chat starts with this session’s context so far; the main session keeps going and nothing here is added to it. Closing a side chat discards it.',
  'aside.start': 'Start side chat',
  'aside.forking': 'Starting side chat…',
  'aside.failed': 'Couldn’t start a side chat: {reason}',
  'aside.retry': 'Retry',
  'aside.context': 'Starts with the main session’s context up to here',
  'aside.empty': 'Type a question below. The main session isn’t affected.',
  'aside.renew': 'New side chat',
  'aside.renew.hint': 'Close this side chat and start over from the latest in the main session',
  'aside.renew.title': 'Start a new side chat?',
  'aside.close': 'Close side chat',
  'aside.close.title': 'Close side chat?',
  'aside.close.note': 'A closed side chat can’t be recovered.',
  'aside.close.yes': 'Close',
  'aside.close.no': 'Cancel',
  'aside.gone':
    'This side chat no longer exists. This happens after the app restarts or the device reconnects.',
  'aside.unsupported': 'This session’s harness doesn’t support side chats.',
  'aside.unstarted': 'Side chats are available once this session has started.',
  'aside.pop': 'Side chat',
  'aside.pop.send': 'Send to side chat',
  'aside.pop.parent': 'Add to main chat',
  'aside.quoted': 'Added to the main session’s composer',
} satisfies Record<string, Entry>
