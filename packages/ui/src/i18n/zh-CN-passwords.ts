// 内置浏览器“已保存的密码”的中文文案（设置页内置浏览器一组里的那一块）。
// 并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-passwords.ts。
import type { Entry } from './types.ts'

export const zhPasswords = {
  'settings.browser.passwords': '已保存的密码',
  'settings.browser.passwords.note':
    '在你自己开的标签里点登录框，可以选一条填上；模型开的标签不填，模型也读不到密码框里的字。这里看不到、也复制不了密码',
  'settings.browser.passwords.empty': '还没有保存的密码。可以从别的浏览器导入。',
  'settings.browser.passwords.search': '搜索站点或用户名',
  'settings.browser.passwords.none': '没有对得上的。',
  'settings.browser.passwords.count': '共 {count} 条',
  'settings.browser.passwords.noUser': '（没有用户名）',
  'settings.browser.passwords.from': '{source} · {day}',
  'settings.browser.passwords.removeAll': '全部删除…',
  'settings.browser.passwords.removeAll.title': '删除所有已保存的密码？',
  'settings.browser.passwords.removeAll.note':
    '内置浏览器里保存的 {count} 条密码都会删掉，找不回来。别的浏览器里的不受影响。',
  'settings.browser.passwords.removeAll.yes': '全部删除',
  'settings.browser.passwords.removed': '已删除 {count} 条密码',
} satisfies Record<string, Entry>
