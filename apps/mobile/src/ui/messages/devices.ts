// 手机端自己的文案：连接线：设备列表、加设备、设备详情。键加前缀 "devices."，中英文各一份，键必须一致（en 的类型约束保证）。
// 桌面界面已有的句子（包括核心要说的话）直接用，不在这里重抄：见 src/ui/i18n.ts。
// 和桌面说法不同的只有手机上做法不一样的那几处：主机钥匙在应用里确认（没有终端和 known_hosts），
// 登录靠应用里的钥匙（没有密钥代理）。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'devices.add': '添加设备',
  'devices.empty.title': '暂无设备',
  'devices.empty.detail':
    '添加一台已安装适配器（codex-harness-adapter）或 Codex 的电脑，手机通过 SSH 连接。',
  'devices.menu.detail': '设备详情',
  'devices.restart.running': '正在重启 {name} 的设备服务…',
  'devices.restart.ok': '知道了',
  'devices.restart.close': '关闭',
  'devices.menu.sessions': '会话',
  'devices.stale': '上次的内容',
  'devices.more': '更多',

  'devices.where': '连接地址',
  'devices.field.host': '主机名或 IP',
  'devices.field.host.hint': '手机需能访问该主机：同一局域网，或通过 Tailscale 等组网',
  'devices.field.port': '端口',
  'devices.field.user': '用户',
  'devices.field.name': '显示名',
  'devices.field.name.hint': '留空则使用主机名',
  'devices.field.missing': '主机、用户和密钥均为必填',

  'devices.key': '密钥',
  'devices.key.none': '暂无密钥。可以生成新密钥，或导入已有的私钥。',
  'devices.key.generate': '生成新密钥',
  'devices.key.import': '导入私钥',
  'devices.key.generated': '在此手机上生成',
  'devices.key.imported': '已导入',
  'devices.key.public': '公钥',
  'devices.key.copy': '复制公钥',
  'devices.key.copied': '已复制',
  'devices.key.authorize':
    '将公钥添加到远程设备上该用户的 ~/.ssh/authorized_keys。在远程设备上运行：',
  'devices.key.copyCommand': '复制命令',
  'devices.key.paste': '私钥',
  'devices.key.paste.hint': '以 -----BEGIN 开头的完整内容，支持 OpenSSH 格式的 Ed25519、RSA、ECDSA',
  'devices.key.pickFile': '从文件选择',
  'devices.key.passphrase': '口令',
  'devices.key.passphrase.hint': '密钥没有口令则留空。口令与私钥一起保存在系统安全存储中',
  'devices.key.doImport': '导入',
  'devices.key.locked': '此密钥设有口令，请填写口令后再导入。',
  'devices.key.invalid': '私钥无效或口令错误。仅支持 OpenSSH 格式的 Ed25519、RSA、ECDSA。',
  'devices.key.failed': '操作失败：{reason}',

  'devices.check': '检查连接',
  'devices.check.hint': '仅检查，不会启动任何服务。',
  'devices.check.service': '设备服务 {version}',
  'devices.check.codex': '仅有 Codex {version}',
  'devices.check.harnesses': '可用的 harness：{names}',
  'devices.check.noHarness': '暂无可用的 harness。连接后可在设备详情中查看原因。',
  'devices.check.idle': '服务当前未运行，连接时会自动启动。',
  'devices.check.codexOnly': '该设备只有 Codex，没有设备服务：只能使用 Codex 这一个 harness。',
  'devices.submit': '添加',

  'devices.trust.title': '首次连接此主机',
  'devices.trust.detail':
    '{host} 的主机密钥（{type}）指纹：\n\n{fingerprint}\n\n可在该设备上运行 {command} 核对，一致后再信任。',
  'devices.trust.yes': '信任',
  'devices.trust.changed.title': '主机密钥已变更',
  'devices.trust.changed.detail':
    '{host} 当前的指纹：\n\n{fingerprint}\n\n之前信任的指纹：\n\n{old}\n\n可能是该设备重装了系统，也可能有人冒充。确认是前者后再信任新密钥。',
  'devices.trust.changed.yes': '信任新密钥',
  'devices.trust.same': '主机密钥未变：{fingerprint}',
  'devices.trust.failed': '无法读取主机密钥：{reason}',
  'devices.retrust': '重新信任主机密钥',

  'devices.why.hostKeyUnknown': '尚未信任此主机的密钥。请点击“重新信任主机密钥”，核对指纹后信任。',
  'devices.why.hostKeyChanged':
    '此主机的密钥与之前信任的不一致，可能是系统已重装，也可能有人冒充。确认之前不要连接；确认后点击“重新信任主机密钥”。',
  'devices.why.auth':
    '登录被拒绝。请确认此手机的公钥已添加到远程设备上该用户的 ~/.ssh/authorized_keys，且用户名正确。',
  'devices.why.keyMissing': '此手机上已没有该设备使用的密钥。请移除该设备后重新添加。',
  'devices.why.keyBroken': '此密钥无法使用。请移除该设备，更换密钥后重新添加。',

  'devices.detail.connection': '连接',
  'devices.detail.user': '用户',
  'devices.detail.key': '密钥',
  'devices.detail.hostKey': '主机指纹',
  'devices.detail.hostKey.none': '尚未信任',
  'devices.detail.peer.unknown': '从未连接',
  'devices.detail.noManage': '此设备没有设置接口，harness 仅可查看。',

  'devices.manage.enable': '启用',
  'devices.manage.settings': '{count} 项设置',
  'devices.manage.env': '环境变量请在电脑上的 Litch 中修改。',

  'devices.color.green': '绿',
  'devices.color.orange': '橙',
  'devices.color.blue': '蓝',
  'devices.color.violet': '紫',
  'devices.color.yellow': '黄',
  'devices.color.brown': '棕',
  'devices.color.red': '红',
  'devices.color.slate': '灰',
} satisfies Record<`devices.${string}`, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'devices.add': 'Add device',
  'devices.empty.title': 'No devices yet',
  'devices.empty.detail':
    'Add a computer with the adapter (codex-harness-adapter) or Codex installed. The phone connects over SSH.',
  'devices.menu.detail': 'Device details',
  'devices.restart.running': 'Restarting the device service on {name}…',
  'devices.restart.ok': 'OK',
  'devices.restart.close': 'Close',
  'devices.menu.sessions': 'Sessions',
  'devices.stale': 'From last time',
  'devices.more': 'More',

  'devices.where': 'Connection',
  'devices.field.host': 'Host name or IP',
  'devices.field.host.hint':
    'Must be reachable from the phone: same local network, or a mesh like Tailscale',
  'devices.field.port': 'Port',
  'devices.field.user': 'User',
  'devices.field.name': 'Display name',
  'devices.field.name.hint': 'Leave empty to use the host name',
  'devices.field.missing': 'Host, user and key are all required',

  'devices.key': 'Key',
  'devices.key.none': 'No keys. Generate one, or import an existing private key.',
  'devices.key.generate': 'Generate a key',
  'devices.key.import': 'Import a private key',
  'devices.key.generated': 'Generated on this phone',
  'devices.key.imported': 'Imported',
  'devices.key.public': 'Public key',
  'devices.key.copy': 'Copy public key',
  'devices.key.copied': 'Copied',
  'devices.key.authorize':
    'Add the public key to ~/.ssh/authorized_keys for this user on the remote device. Run this there:',
  'devices.key.copyCommand': 'Copy command',
  'devices.key.paste': 'Private key',
  'devices.key.paste.hint':
    'The full block starting with -----BEGIN. OpenSSH Ed25519, RSA or ECDSA',
  'devices.key.pickFile': 'Pick a file',
  'devices.key.passphrase': 'Passphrase',
  'devices.key.passphrase.hint':
    'Leave empty if the key has none. It’s stored with the key in the system’s secure storage',
  'devices.key.doImport': 'Import',
  'devices.key.locked': 'This key has a passphrase. Enter it and import again.',
  'devices.key.invalid':
    'Not a valid private key, or the passphrase is wrong. Only OpenSSH Ed25519, RSA and ECDSA keys are supported.',
  'devices.key.failed': 'Couldn’t complete: {reason}',

  'devices.check': 'Check connection',
  'devices.check.hint': 'Checks only. Nothing is started.',
  'devices.check.service': 'Device service {version}',
  'devices.check.codex': 'Codex {version} only',
  'devices.check.harnesses': 'Harnesses available: {names}',
  'devices.check.noHarness':
    'No harness available. After connecting, see the device details for why.',
  'devices.check.idle': 'The service isn’t running. It starts when you connect.',
  'devices.check.codexOnly':
    'This device has only Codex, no device service, so Codex is the only harness.',
  'devices.submit': 'Add',

  'devices.trust.title': 'First connection to this host',
  'devices.trust.detail':
    'Host key ({type}) fingerprint for {host}:\n\n{fingerprint}\n\nTo verify, run {command} on that device. Trust it only if they match.',
  'devices.trust.yes': 'Trust',
  'devices.trust.changed.title': 'Host key changed',
  'devices.trust.changed.detail':
    '{host} now presents:\n\n{fingerprint}\n\nPreviously trusted:\n\n{old}\n\nThe device may have been reinstalled, or someone may be impersonating it. Trust the new key only if you are sure it was reinstalled.',
  'devices.trust.changed.yes': 'Trust the new key',
  'devices.trust.same': 'Host key hasn’t changed: {fingerprint}',
  'devices.trust.failed': 'Couldn’t read the host key: {reason}',
  'devices.retrust': 'Trust the host key again',

  'devices.why.hostKeyUnknown':
    'This host’s key isn’t trusted yet. Tap “Trust the host key again”, check the fingerprint and trust it.',
  'devices.why.hostKeyChanged':
    'This host’s key differs from the trusted one: the device may have been reinstalled, or someone may be impersonating it. Don’t connect until you’re sure; then tap “Trust the host key again”.',
  'devices.why.auth':
    'Login refused. Make sure this phone’s public key is in ~/.ssh/authorized_keys for this user on the remote device, and the user name is correct.',
  'devices.why.keyMissing':
    'The key for this device is no longer on this phone. Remove the device and add it again.',
  'devices.why.keyBroken':
    'This key can’t be used. Remove the device and add it again with another key.',

  'devices.detail.connection': 'Connection',
  'devices.detail.user': 'User',
  'devices.detail.key': 'Key',
  'devices.detail.hostKey': 'Host fingerprint',
  'devices.detail.hostKey.none': 'Not trusted yet',
  'devices.detail.peer.unknown': 'Never connected',
  'devices.detail.noManage': 'This device has no settings interface. Harnesses are read-only.',

  'devices.manage.enable': 'Enabled',
  'devices.manage.settings': '{count} settings',
  'devices.manage.env': 'Edit environment variables in Litch on a computer.',

  'devices.color.green': 'Green',
  'devices.color.orange': 'Orange',
  'devices.color.blue': 'Blue',
  'devices.color.violet': 'Violet',
  'devices.color.yellow': 'Yellow',
  'devices.color.brown': 'Brown',
  'devices.color.red': 'Red',
  'devices.color.slate': 'Slate',
}
