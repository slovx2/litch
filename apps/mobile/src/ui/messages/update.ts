// 手机端自己的文案：应用更新（src/update/，设备列表顶上的横条、设置页“关于”里的那几行）。键加前缀 "update."，中英文键一致。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'update.banner.available': '有新版本 {version}',
  'update.banner.downloading': '正在下载 {version}',
  'update.banner.ready': '新版本 {version} 已下载',
  'update.action.update': '更新',
  'update.action.install': '安装',
  'update.action.check': '检查更新',
  'update.auto': '自动检查更新',
  'update.auto.note':
    '启动后和每隔几个小时查一次有没有新版本；关了只在点“检查更新”时查。新版本要点了才下载。',
  'update.state.idle': '还没查过更新',
  'update.state.checking': '正在检查更新…',
  'update.state.latest': '已经是最新版本',
  'update.state.available': '有新版本 {version}，点“更新”下载',
  'update.state.downloading': '正在下载 {version}',
  'update.state.ready': '{version} 已下载，交给系统安装',
  'update.permission': '要先在系统设置里允许 Litch “安装未知应用”，打开开关后返回这里会接着安装。',
  'update.fail.title': '这次没更新成',
  'update.fail.network': '没从更新服务器拿到更新信息',
  'update.fail.feed': '更新信息读不了',
  'update.fail.size': '下载的文件大小不对，可能没下完整',
  'update.fail.checksum': '下载的文件校验不通过，已删掉',
  'update.fail.package': '下载的不是能装的 Litch 新版本',
  'update.fail.signature': '新版本的签名和装着的这个不一样，系统不会让它覆盖安装',
  'update.fail.install': '没能打开系统安装器',
  'update.fail.retry': '过一会儿会自己再查，也可以点“检查更新”。',
} satisfies Record<`update.${string}`, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'update.banner.available': 'Version {version} is available',
  'update.banner.downloading': 'Downloading {version}',
  'update.banner.ready': 'Version {version} is downloaded',
  'update.action.update': 'Update',
  'update.action.install': 'Install',
  'update.action.check': 'Check for updates',
  'update.auto': 'Check for updates automatically',
  'update.auto.note':
    'Checks after launch and every few hours. When off, Litch only checks when you tap “Check for updates”. New versions download only when you tap.',
  'update.state.idle': 'Not checked yet',
  'update.state.checking': 'Checking for updates…',
  'update.state.latest': 'You have the latest version',
  'update.state.available': 'Version {version} is available. Tap “Update” to download it',
  'update.state.downloading': 'Downloading {version}',
  'update.state.ready': '{version} is downloaded and handed to the system installer',
  'update.permission':
    'Allow Litch to “install unknown apps” in system settings first. Turn it on and come back to continue.',
  'update.fail.title': 'The update did not go through',
  'update.fail.network': 'Could not get update information from the server',
  'update.fail.feed': 'Could not read the update information',
  'update.fail.size': 'The download has the wrong size and may be incomplete',
  'update.fail.checksum': 'The download failed its checksum and was deleted',
  'update.fail.package': 'The download is not an installable newer Litch',
  'update.fail.signature':
    'The new version is signed differently from this one, so the system will not install it over this app',
  'update.fail.install': 'Could not open the system installer',
  'update.fail.retry': 'Litch will check again later, or tap “Check for updates”.',
}
