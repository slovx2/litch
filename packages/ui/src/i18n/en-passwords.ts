// 内置浏览器“已保存的密码”的英文文案。键必须和 zh-CN-passwords.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhPasswords } from './zh-CN-passwords.ts'

export const enPasswords: Record<keyof typeof zhPasswords, Entry> = {
  'settings.browser.passwords': 'Saved passwords',
  'settings.browser.passwords.note':
    'Click a sign-in field to fill one. The model never fills passwords; when it needs you signed in, it hands you the tab. It can’t read password fields or see save prompts. Passwords can’t be shown or copied here',
  'settings.browser.passwords.empty':
    'No saved passwords. You can import them from another browser.',
  'settings.browser.passwords.search': 'Search sites or usernames',
  'settings.browser.passwords.none': 'No matches.',
  'settings.browser.passwords.count': ({ count }) =>
    Number(count) === 1 ? '1 password' : `${count} passwords`,
  'settings.browser.passwords.noUser': '(no username)',
  'settings.browser.passwords.from': '{source} · {day}',
  'settings.browser.passwords.removeAll': 'Delete all…',
  'settings.browser.passwords.removeAll.title': 'Delete all saved passwords?',
  'settings.browser.passwords.removeAll.note': ({ count }) =>
    `${Number(count) === 1 ? 'The 1 password' : `All ${count} passwords`} saved in the built-in browser will be deleted. This can’t be undone. Other browsers aren’t affected.`,
  'settings.browser.passwords.removeAll.yes': 'Delete all',
  'settings.browser.passwords.removed': ({ count }) =>
    Number(count) === 1 ? 'Deleted 1 password' : `Deleted ${count} passwords`,
  'settings.browser.passwords.saved': 'Saved in the built-in browser',
  'settings.browser.never': 'Never save passwords for',
  'settings.browser.never.empty': 'None.',
  'settings.browser.never.at': 'Added {day}',
  'browser.save.ask': 'Save password for {user} on {site}?',
  'browser.save.update': 'Update password for {user} on {site}?',
  'browser.save.yes': 'Save',
  'browser.save.no': 'Not now',
  'browser.save.updateYes': 'Update',
  'browser.save.updateNo': 'Not now',
  'browser.save.never': 'Never for this site',
  'browser.save.more': ({ count }) => (Number(count) === 1 ? '1 more' : `${count} more`),
  'browser.save.unavailable':
    'Can’t save the password for {user} on {site}: the system keychain isn’t available, and Litch doesn’t store unencrypted passwords.',
  'browser.save.close': 'OK',
  'browser.signIn.title': 'The agent asks you to sign in to this site',
  'browser.signIn.noOrigin': '(not a website)',
  'browser.signIn.claim': 'Agent’s note: {site} · {reason}',
  'browser.signIn.withdrawn': 'The agent withdrew its sign-in request',
  'browser.signIn.withdrawnNote':
    'This tab was reloaded. Don’t type passwords here: the agent can read the page when it uses this tab again.',
  'browser.signIn.dismiss': 'OK',
  'browser.signIn.closed': 'Sign-in tab closed',
  'browser.signIn.closedNote':
    'The page couldn’t be reloaded safely, so Litch closed the tab. Nothing typed there was passed to the agent.',
  'browser.signIn.note':
    'Sign in on the page below (saved passwords work here), then click “Done, hand back”. The agent can’t use this tab meanwhile. Password fields are cleared before it gets the tab back, so it never sees what you typed.',
  'browser.signIn.done': 'Done, hand back',
  'browser.signIn.cancel': 'Cancel',
  'browser.signIn.show': 'Show tab',
  'browser.save.failed': 'Couldn’t save: {reason}',
  'browser.save.fileFailed':
    'Couldn’t save: the password file can’t be read or written right now. The prompt stays so you can try again.',
}
