// 内置浏览器“已保存的密码”的中文文案（设置页内置浏览器一组里的那一块）。
// 并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-passwords.ts。
import type { Entry } from './types.ts'

export const zhPasswords = {
  'settings.browser.passwords': '已保存的密码',
  'settings.browser.passwords.note':
    '点登录框可以选一条填上，模型开的标签里模型也能选；模型读不到密码框里的字，也看不到保存提示。这里看不到、也复制不了密码',
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
  'settings.browser.passwords.saved': '在内置浏览器里保存',
  'settings.browser.never': '从不保存密码的网站',
  'settings.browser.never.note':
    '在保存提示上点了“这个网站永不”的；删掉之后，在这个网站登录又会问你',
  'settings.browser.never.empty': '没有从不保存密码的网站。',
  'settings.browser.never.at': '{day} 加入',
  'browser.save.ask': '要保存 {site} 上 {user} 的密码吗？',
  'browser.save.askNoUser': '要保存 {site} 的密码吗？',
  'browser.save.update': '要更新 {site} 上 {user} 的密码吗？',
  'browser.save.updateNoUser': '要更新 {site} 的密码吗？',
  'browser.save.yes': '保存',
  'browser.save.no': '不保存',
  'browser.save.updateYes': '更新',
  'browser.save.updateNo': '不更新',
  'browser.save.never': '这个网站永不',
  'browser.save.more': '还有 {count} 条',
} satisfies Record<string, Entry>
