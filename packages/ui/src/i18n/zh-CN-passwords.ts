// 内置浏览器“已保存的密码”的中文文案（设置页内置浏览器一组里的那一块）。
// 并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-passwords.ts。
import type { Entry } from './types.ts'

export const zhPasswords = {
  'settings.browser.passwords': '已保存的密码',
  'settings.browser.passwords.note':
    '点击登录框即可选择填充。模型不会代填密码，需要登录时会把标签交给你；模型读不到密码框内容，也看不到保存提示。此处无法查看或复制密码',
  'settings.browser.passwords.empty': '暂无已保存的密码，可从其他浏览器导入。',
  'settings.browser.passwords.search': '搜索网站或用户名',
  'settings.browser.passwords.none': '无匹配结果。',
  'settings.browser.passwords.count': '共 {count} 条',
  'settings.browser.passwords.noUser': '（无用户名）',
  'settings.browser.passwords.from': '{source} · {day}',
  'settings.browser.passwords.removeAll': '全部删除…',
  'settings.browser.passwords.removeAll.title': '删除所有已保存的密码？',
  'settings.browser.passwords.removeAll.note':
    '内置浏览器中保存的 {count} 条密码将被删除，且无法恢复。其他浏览器中的密码不受影响。',
  'settings.browser.passwords.removeAll.yes': '全部删除',
  'settings.browser.passwords.removed': '已删除 {count} 条密码',
  'settings.browser.passwords.saved': '保存在内置浏览器中',
  'settings.browser.never': '从不保存密码的网站',
  'settings.browser.never.empty': '暂无。',
  'settings.browser.never.at': '{day} 添加',
  'browser.save.ask': '保存 {site} 上 {user} 的密码？',
  'browser.save.update': '更新 {site} 上 {user} 的密码？',
  'browser.save.yes': '保存',
  'browser.save.no': '不保存',
  'browser.save.updateYes': '更新',
  'browser.save.updateNo': '不更新',
  'browser.save.never': '此网站一律不保存',
  'browser.save.more': '另有 {count} 条',
  'browser.save.unavailable':
    '无法保存 {site} 上 {user} 的密码：本机的系统钥匙串当前不可用，Litch 不会保存未加密的密码。',
  'browser.save.close': '知道了',
  'browser.signIn.title': '代理请求你登录此网站',
  'browser.signIn.noOrigin': '（此页不是网站）',
  'browser.signIn.claim': '代理说明：{site} · {reason}',
  'browser.signIn.withdrawn': '代理已撤回登录请求',
  'browser.signIn.withdrawnNote':
    '此标签已重新加载。请勿再在此输入密码：代理继续使用此标签时可以读取页面内容。',
  'browser.signIn.dismiss': '知道了',
  'browser.signIn.closed': '登录标签已关闭',
  'browser.signIn.closedNote':
    '此页无法安全地重新加载，Litch 已关闭该标签。其中输入的内容未交给代理。',
  'browser.signIn.note':
    '请在下方网页中自行登录（可使用已保存的密码），完成后点击“完成并交还”。在此期间代理无法操作此标签；交还前会清空密码框，代理看不到你输入的内容。',
  'browser.signIn.done': '完成并交还',
  'browser.signIn.cancel': '取消',
  'browser.signIn.show': '切换到该标签',
  'browser.save.failed': '保存失败：{reason}',
  'browser.save.fileFailed': '保存失败：密码库文件当前无法读写。提示会保留，可稍后重试。',
} satisfies Record<string, Entry>
