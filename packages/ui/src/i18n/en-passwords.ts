// 内置浏览器“已保存的密码”的英文文案。键必须和 zh-CN-passwords.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhPasswords } from './zh-CN-passwords.ts'

export const enPasswords: Record<keyof typeof zhPasswords, Entry> = {
  'settings.browser.passwords': 'Saved passwords',
  'settings.browser.passwords.note':
    'Click a sign-in field to fill one of these. The model never fills them: when it needs you signed in, it hands the tab to you. The model cannot read password fields or see save prompts. Passwords cannot be shown or copied here',
  'settings.browser.passwords.empty':
    'No saved passwords yet. You can import them from another browser.',
  'settings.browser.passwords.search': 'Search sites or usernames',
  'settings.browser.passwords.none': 'Nothing matches.',
  'settings.browser.passwords.count': ({ count }) =>
    Number(count) === 1 ? '1 password' : `${count} passwords`,
  'settings.browser.passwords.noUser': '(no username)',
  'settings.browser.passwords.from': '{source} · {day}',
  'settings.browser.passwords.removeAll': 'Delete all…',
  'settings.browser.passwords.removeAll.title': 'Delete all saved passwords?',
  'settings.browser.passwords.removeAll.note': ({ count }) =>
    `${Number(count) === 1 ? 'The 1 password' : `All ${count} passwords`} saved in the Litch browser will be deleted. This cannot be undone. Passwords in your other browsers are not affected.`,
  'settings.browser.passwords.removeAll.yes': 'Delete all',
  'settings.browser.passwords.removed': ({ count }) =>
    Number(count) === 1 ? 'Deleted 1 password' : `Deleted ${count} passwords`,
  'settings.browser.passwords.saved': 'Saved in the Litch browser',
  'settings.browser.never': 'Never save passwords for',
  'settings.browser.never.note':
    'Sites where you chose “Never for this site”; remove one to be asked again when you sign in there',
  'settings.browser.never.empty': 'No sites are excluded.',
  'settings.browser.never.at': 'added {day}',
  'browser.save.ask': 'Save the password for {user} on {site}?',
  'browser.save.update': 'Update the password for {user} on {site}?',
  'browser.save.yes': 'Save',
  'browser.save.no': 'Not now',
  'browser.save.updateYes': 'Update',
  'browser.save.updateNo': 'Not now',
  'browser.save.never': 'Never for this site',
  'browser.save.more': ({ count }) => (Number(count) === 1 ? '1 more' : `${count} more`),
  'browser.save.unavailable':
    "The password for {user} on {site} can't be saved: the system keychain isn't available on this computer, and Litch doesn't store unencrypted passwords.",
  'browser.save.close': 'OK',
  'browser.signIn.title': 'The agent asks you to sign in to this site',
  'browser.signIn.noOrigin': '(this page is not a website)',
  'browser.signIn.claim': 'The agent says: {site} · {reason}',
  'browser.signIn.withdrawn': 'The agent withdrew its sign-in request',
  'browser.signIn.withdrawnNote':
    'This tab was reloaded. Do not type passwords here anymore: the agent can read the page when it uses this tab again.',
  'browser.signIn.dismiss': 'OK',
  'browser.signIn.note':
    'Sign in on the page below yourself (saved passwords work here), then click "Done, hand back". The agent cannot touch this tab meanwhile; password fields are cleared before it gets the tab back, and it never sees what you typed.',
  'browser.signIn.done': 'Done, hand back',
  'browser.signIn.cancel': 'Cancel',
  'browser.signIn.show': 'Show that tab',
  'browser.save.failed': 'Not saved: {reason}',
  'browser.save.fileFailed':
    "Not saved: the saved passwords file can't be read or written right now. The prompt stays so you can try again.",
}
