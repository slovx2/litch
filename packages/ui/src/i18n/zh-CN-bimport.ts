// 内置浏览器“从别的浏览器导入”的中文文案：设置页那一行、浏览器面板的菜单和横幅、导入对话框。
// 并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-bimport.ts。
// 来源浏览器的名字（Google Chrome、Firefox……）是产品名，由主进程给，不翻译。
import type { Entry } from './types.ts'

export const zhBimport = {
  // 入口
  'bimport.entry.title': '从浏览器导入',
  'bimport.entry.note':
    '把 Chrome、Edge、Firefox 等浏览器里的 Cookie（网站的登录状态）、已保存的密码和浏览记录导进内置浏览器。一次性导入，不会持续同步。',
  'bimport.entry.button': '导入…',
  'bimport.entry.last': '上次导入在 {day}',
  'bimport.menu': '浏览器菜单',
  'bimport.menu.import': '导入 Cookie 和密码…',
  'bimport.banner': '从你常用的浏览器导入 Cookie 和密码，网站上就不用重新登录。',
  'bimport.banner.import': '导入',
  'bimport.banner.later': '以后再说',

  // 对话框：选
  'bimport.title': '从浏览器导入',
  'bimport.loading': '正在查找这台电脑上的浏览器…',
  'bimport.loadFailed': '没找成：{reason}',
  'bimport.none':
    '这台电脑上没找到能导入的浏览器。支持 Google Chrome、Microsoft Edge、Brave、Arc、Chromium、Vivaldi 和 Firefox。',
  'bimport.source': '来源',
  'bimport.profile': '资料',
  'bimport.profile.default': '{name}（默认）',
  'bimport.block.noProfiles': '没找到资料',
  'bimport.block.nothing': '没有能导入的数据',
  'bimport.kinds': '导入哪些',
  'bimport.kind.cookies': 'Cookie',
  'bimport.kind.cookies.note': '网站的登录状态，导进来之后不用重新登录',
  'bimport.kind.passwords': '已保存的密码',
  'bimport.kind.passwords.note': '存进 Litch 自己的密码库，只在你自己打开的网页里自动填充',
  'bimport.kind.history': '浏览记录',
  'bimport.kind.history.note': '最近 90 天的，地址栏输入时会联想',
  'bimport.look.unsupported': '这台电脑上还读不了',
  'bimport.look.missing': '这份资料里没有',
  'bimport.domains': '只导这些网站的 Cookie',
  'bimport.domains.placeholder': 'github.com, example.com',
  'bimport.domains.note': '写域名或网址，用逗号或换行分开，子域名一起算。不勾就导全部。',
  'bimport.hint.close':
    '导入前请完全退出 {name}（包括在后台运行的）。它开着的时候数据文件被占着，可能导不进来。',
  'bimport.hint.keychain':
    '读 Cookie 和密码时 macOS 会弹出钥匙串的授权框，问能不能用 {name} 的密钥。选“允许”才导得进来；拒绝了也可以重试。',
  'bimport.hint.systemAuth': '读 Cookie 和密码时系统会弹出授权框，允许之后才导得进来。',
  'bimport.elevate': '允许用管理员权限读取 Cookie 和密码',
  'bimport.elevate.note':
    '这台电脑上读 {name} 的 Cookie 和密码要管理员同意，勾选后 Windows 会弹出用户账户控制询问。不勾也行，这两类会跳过。',
  'bimport.problem.noSource': '先选一个来源',
  'bimport.problem.noKinds': '至少选一类',
  'bimport.problem.noDomains': '至少写一个网站，或者取消“只导这些网站的 Cookie”',
  'bimport.problem.badDomains': '这几项认不出：{list}',
  'bimport.cancel': '取消',
  'bimport.start': '导入',

  // 对话框：进度
  'bimport.running': '正在从 {name} 导入…',
  'bimport.stage.waiting': '等待',
  'bimport.stage.reading': '正在读取',
  'bimport.stage.writing': '正在写入',
  'bimport.stage.done': '完成',
  'bimport.stop': '停止导入',
  'bimport.stopping': '正在停止…',

  // 对话框：结果
  'bimport.overall.ok': '导入完成',
  'bimport.overall.partial': '部分导入成功',
  'bimport.overall.failed': '没有导入成功',
  'bimport.overall.cancelled': '导入已停止，已经写进去的都留着',
  'bimport.overall.profileGone':
    '这份资料找不到了，可能浏览器被卸载、资料被删掉了。重新查找之后再选。',
  'bimport.overall.busy': '另一个导入正在进行，等它结束再试。',
  'bimport.status.ok': '完成',
  'bimport.status.okFailed': '有几条没写进去',
  'bimport.status.empty': '来源里没有数据',
  'bimport.status.partial': '有一部分读不出来，其余的已导入',
  'bimport.status.missing': '这份资料里没有这类数据',
  'bimport.status.locked': '{name} 还开着，数据文件被占用。完全退出它之后重试。',
  'bimport.status.denied': '系统授权被拒绝了。重试时在弹框里选“允许”。',
  'bimport.status.needsElevation': '要管理员同意才能读。勾选下面的“允许用管理员权限读取”之后重试。',
  'bimport.status.unsupported': '这台电脑上还读不了这类数据',
  'bimport.status.cancelled': '已停止',
  'bimport.status.failed': '没读出来，可以重试',
  'bimport.status.skipped': '导入停了，没轮上',
  'bimport.count.imported': '导入 {n}',
  'bimport.count.existing': '已存在 {n}',
  'bimport.count.invalid': '无效 {n}',
  'bimport.count.failed': '失败 {n}',
  'bimport.count.found': '来源里共 {n} 条',
  'bimport.details': '详情',
  'bimport.retry': '重试',
  'bimport.again': '重新选择',
  'bimport.rescan': '重新查找',
  'bimport.startFailed': '没开始成：{reason}',
  'bimport.close': '关闭',
  'bimport.done': '完成',
} satisfies Record<string, Entry>
