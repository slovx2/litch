// 手机端自己的文案：应用更新（src/update/，设备列表顶上的横条、设置页“关于”里的那几行）。键加前缀 "update."，中英文键一致。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'update.banner.available': '有新版本 {version}',
  'update.banner.downloading': '正在下载 {version}',
  'update.banner.ready': '新版本 {version} 已下载',
  'update.action.update': '更新',
  'update.action.install': '安装',
  'update.action.check': '检查更新',
  'update.action.details': '详情',
  'update.auto': '自动检查更新',
  'update.auto.note':
    '启动后及每隔几小时检查一次；关闭后仅在点击“检查更新”时检查。新版本需手动下载。',
  'update.state.idle': '尚未检查更新',
  'update.state.checking': '正在检查更新…',
  'update.state.latest': '已是最新版本',
  'update.state.available': '有新版本 {version}，点击“更新”下载',
  'update.state.downloading': '正在下载 {version}',
  'update.state.ready': '{version} 已下载，已交给系统安装',
  'update.permission': '请先在系统设置中允许 Litch“安装未知应用”，开启后返回此处将继续安装。',
  'update.fail.title': '更新失败',
  'update.fail.network': '无法从更新服务器获取更新信息',
  'update.fail.feed': '无法读取更新信息',
  'update.fail.size': '下载的文件大小不符，可能未完整下载',
  'update.fail.checksum': '下载的文件校验失败，已删除',
  'update.fail.package': '下载的文件不是可安装的 Litch 新版本',
  'update.fail.signature':
    '新版本的签名与当前安装的不一致，系统不允许覆盖安装。卸载后从发布页装一次发布版即可恢复自动更新',
  'update.fail.install': '无法打开系统安装器',
  'update.fail.retry': '稍后会自动重新检查，也可点击“检查更新”。',
} satisfies Record<`update.${string}`, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'update.banner.available': 'Version {version} is available',
  'update.banner.downloading': 'Downloading {version}',
  'update.banner.ready': 'Version {version} is downloaded',
  'update.action.update': 'Update',
  'update.action.install': 'Install',
  'update.action.check': 'Check for updates',
  'update.action.details': 'Details',
  'update.auto': 'Check for updates automatically',
  'update.auto.note':
    'Checks at launch and every few hours. When off, Litch checks only when you tap “Check for updates”. New versions download only when you tap Update.',
  'update.state.idle': 'Not checked yet',
  'update.state.checking': 'Checking for updates…',
  'update.state.latest': 'You have the latest version',
  'update.state.available': 'Version {version} is available. Tap “Update” to download',
  'update.state.downloading': 'Downloading {version}',
  'update.state.ready': '{version} downloaded and handed to the system installer',
  'update.permission':
    'Allow Litch to “install unknown apps” in system settings, then come back to continue.',
  'update.fail.title': 'Update failed',
  'update.fail.network': 'Couldn’t get update information from the server',
  'update.fail.feed': 'Couldn’t read the update information',
  'update.fail.size': 'The download has the wrong size and may be incomplete',
  'update.fail.checksum': 'The download failed its checksum and was deleted',
  'update.fail.package': 'The download isn’t an installable newer version of Litch',
  'update.fail.signature':
    'The new version is signed differently, so the system won’t install it over this app. Uninstall it and install the release build once to get updates again',
  'update.fail.install': 'Couldn’t open the system installer',
  'update.fail.retry': 'Litch will check again later. You can also tap “Check for updates”.',
}
