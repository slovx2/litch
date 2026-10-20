// 内置浏览器“已保存的密码”的英文文案。键必须和 zh-CN-passwords.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhPasswords } from './zh-CN-passwords.ts'

export const enPasswords: Record<keyof typeof zhPasswords, Entry> = {
  'settings.browser.passwords': 'Saved passwords',
  'settings.browser.passwords.note':
    'Click a sign-in field in a tab you opened yourself to fill one of these. Tabs the model opened are never filled, and the model cannot read password fields. Passwords cannot be shown or copied here',
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
}
