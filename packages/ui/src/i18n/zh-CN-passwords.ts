// 内置浏览器“已保存的密码”的中文文案（设置页内置浏览器一组里的那一块）。
// 并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-passwords.ts。
import type { Entry } from './types.ts'

export const zhPasswords = {
  'settings.browser.passwords': '已保存的密码',
  'settings.browser.passwords.note':
    '点登录框可以选一条填上。模型从不替你填：要登录时它会把标签交给你。模型读不到密码框里的字，也看不到保存提示。这里看不到、也复制不了密码',
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
  'browser.save.update': '要更新 {site} 上 {user} 的密码吗？',
  'browser.save.yes': '保存',
  'browser.save.no': '不保存',
  'browser.save.updateYes': '更新',
  'browser.save.updateNo': '不更新',
  'browser.save.never': '这个网站永不',
  'browser.save.more': '还有 {count} 条',
  'browser.save.unavailable':
    '在 {site} 上登录的 {user} 没法保存：这台电脑的系统钥匙串现在用不了，Litch 不存没加密的密码。',
  'browser.save.close': '知道了',
  'browser.signIn.title': '代理请你登录这个网站',
  'browser.signIn.noOrigin': '（这一页不是网站）',
  'browser.signIn.claim': '代理说：{site} · {reason}',
  'browser.signIn.withdrawn': '代理已收回登录请求',
  'browser.signIn.withdrawnNote':
    '这个标签已重新打开。别再在这里输入密码：代理接着用这个标签时看得到页面上的内容。',
  'browser.signIn.dismiss': '知道了',
  'browser.signIn.note':
    '在下面的网页里自己登录（可以用已保存的密码），好了点“完成，交还”。这段时间代理碰不了这个标签；交还前会清空密码框，代理看不到你输入的内容。',
  'browser.signIn.done': '完成，交还',
  'browser.signIn.cancel': '取消',
  'browser.signIn.show': '切到那个标签',
  'browser.save.failed': '没存上：{reason}',
  'browser.save.fileFailed': '没存上：密码库文件现在读写不了，提示先留着，可以再试。',
} satisfies Record<string, Entry>
