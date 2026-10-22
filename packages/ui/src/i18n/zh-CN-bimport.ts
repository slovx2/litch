// 内置浏览器“从别的浏览器导入”的中文文案：设置页那一行、浏览器面板的菜单和横幅、导入对话框。
// 并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-bimport.ts。
// 来源浏览器的名字（Google Chrome、Firefox……）是产品名，由主进程给，不翻译。
import type { Entry } from './types.ts'

export const zhBimport = {
  // 入口
  'bimport.entry.title': '从浏览器导入',
  'bimport.entry.note':
    '将 Chrome、Edge、Firefox 等浏览器的 Cookie 和已保存的密码一次性导入内置浏览器，不会持续同步。',
  'bimport.entry.button': '导入…',
  'bimport.entry.last': '上次导入：{day}',
  'bimport.menu': '浏览器菜单',
  'bimport.menu.import': '导入 Cookie 和密码…',
  'bimport.banner': '从常用浏览器导入 Cookie 和密码，无需在网站上重新登录。',
  'bimport.banner.import': '导入',
  'bimport.banner.later': '稍后',

  // 对话框：选
  'bimport.title': '从浏览器导入',
  'bimport.loading': '正在查找本机的浏览器…',
  'bimport.loadFailed': '查找失败：{reason}',
  'bimport.none':
    '本机未找到可导入的浏览器。支持 Google Chrome、Microsoft Edge、Brave、Arc、Chromium、Vivaldi 和 Firefox。',
  'bimport.unusable': '找到以下浏览器，但均无可导入的数据：',
  'bimport.source': '来源',
  'bimport.profile': '资料',
  'bimport.profile.default': '{name}（默认）',
  'bimport.block.noProfiles': '未找到资料',
  'bimport.block.nothing': '无可导入的数据',
  'bimport.kinds': '导入内容',
  'bimport.kind.cookies': 'Cookie',
  'bimport.kind.passwords': '已保存的密码',
  'bimport.kind.passwords.note': '保存到 Litch 的密码库，供内置浏览器自动填充',
  'bimport.look.unsupported': '本机暂不支持读取',
  'bimport.look.missing': '此资料中没有',
  'bimport.domains': '仅导入以下网站的 Cookie',
  'bimport.domains.placeholder': 'github.com, example.com',
  'bimport.domains.note': '填写域名或网址，以逗号或换行分隔，包含子域名。',
  'bimport.hint.close':
    '导入前请完全退出 {name}（包括后台进程），否则数据文件被占用，可能无法导入。',
  'bimport.hint.keychain':
    '读取时 macOS 会弹出钥匙串授权，询问是否允许使用 {name} 的密钥。选择“允许”才能导入，拒绝后可重试。',
  'bimport.hint.systemAuth': '读取时系统会请求授权，允许后才能导入。',
  'bimport.hint.appBound':
    '当前版本无法导入 Windows 上新版 {name} 受保护的数据（主要是 Cookie），其余数据正常导入。',
  'bimport.problem.noSource': '请选择来源',
  'bimport.problem.noKinds': '至少选择一类',
  'bimport.problem.noDomains': '至少填写一个网站，或取消勾选“仅导入以下网站的 Cookie”',
  'bimport.problem.badDomains': '无法识别：{list}',
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
  'bimport.overall.failed': '导入失败',
  'bimport.overall.existing': '没有新数据，均已在 Litch 中',
  'bimport.overall.nothing': '未导入任何数据',
  'bimport.overall.cancelled': '导入已停止，已写入的数据会保留',
  'bimport.overall.profileGone': '找不到此资料，浏览器可能已卸载或资料已删除。请重新查找后再选择。',
  'bimport.overall.busy': '另一项导入正在进行，请在其结束后重试。',
  'bimport.status.ok': '完成',
  'bimport.status.okFailed': '部分条目写入失败',
  'bimport.status.allExisting': '均已存在',
  'bimport.status.allInvalid': '均无效，未导入',
  'bimport.status.storeUnavailable': '本机无法使用系统加密存储，密码无法保存',
  'bimport.status.empty': '来源中没有数据',
  'bimport.status.partial': '部分未导入',
  'bimport.status.missing': '此资料中没有这类数据',
  'bimport.status.locked': '{name} 仍在运行，数据文件被占用。请完全退出后重试。',
  'bimport.status.denied': '系统授权被拒绝。重试时请在弹窗中选择“允许”。',
  'bimport.status.needsElevation':
    '当前版本无法导入 Windows 上新版 Chromium 内核浏览器受保护的数据（主要是 Cookie），其余数据正常导入。',
  'bimport.status.unsupported': '本机暂不支持读取这类数据',
  'bimport.status.cancelled': '已停止',
  'bimport.status.failed': '导入失败',
  'bimport.status.skipped': '导入已停止，未处理',
  'bimport.count.imported': '已导入 {n}',
  'bimport.count.existing': '已存在 {n}',
  'bimport.count.invalid': '无效 {n}',
  'bimport.count.failed': '失败 {n}',
  'bimport.count.found': '来源共 {n} 条',
  'bimport.details': '详情',
  'bimport.retry': '重试',
  'bimport.again': '重新选择',
  'bimport.rescan': '重新查找',
  'bimport.startFailed': '无法开始导入：{reason}',
  'bimport.refused': 'Litch 未接受此次导入，请关闭对话框后重试',
  'bimport.close': '关闭',
  'bimport.done': '完成',
} satisfies Record<string, Entry>
