// 手机端自己的文案：连接线：设备列表、加设备、设备详情。键加前缀 "devices."，中英文各一份，键必须一致（en 的类型约束保证）。
// 桌面界面已有的句子（包括核心要说的话）直接用，不在这里重抄：见 src/ui/i18n.ts。
// 和桌面说法不同的只有手机上做法不一样的那几处：主机钥匙在应用里确认（没有终端和 known_hosts），
// 登录靠应用里的钥匙（没有密钥代理）。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'devices.add': '加设备',
  'devices.empty.title': '还没有设备',
  'devices.empty.detail':
    '加一台电脑：上面装好适配器（codex-harness-adapter）或者 codex，手机经 SSH 连过去。',
  'devices.menu.detail': '设备详情',
  'devices.menu.sessions': '会话',
  'devices.stale': '上次的内容',
  'devices.more': '更多',

  'devices.where': '连到哪',
  'devices.field.host': '主机名或 IP',
  'devices.field.host.hint': '手机要能连到它：同一个局域网，或者经 Tailscale 之类的组网',
  'devices.field.port': '端口',
  'devices.field.user': '用户',
  'devices.field.name': '显示名',
  'devices.field.name.hint': '留空就用主机名',
  'devices.field.missing': '主机、用户和钥匙都要有',

  'devices.key': '钥匙',
  'devices.key.none': '还没有钥匙。生成一把新的，或者导入一把已有的私钥。',
  'devices.key.generate': '生成新钥匙',
  'devices.key.import': '导入私钥',
  'devices.key.generated': '在这台手机上生成',
  'devices.key.imported': '导入的',
  'devices.key.public': '公钥',
  'devices.key.copy': '复制公钥',
  'devices.key.copied': '已复制',
  'devices.key.authorize':
    '把公钥加到那台机器上这个用户的 ~/.ssh/authorized_keys 里。在那台机器上运行这一句：',
  'devices.key.copyCommand': '复制这一句',
  'devices.key.paste': '私钥',
  'devices.key.paste.hint': '-----BEGIN 开头的整段，OpenSSH 格式的 Ed25519、RSA、ECDSA',
  'devices.key.pickFile': '从文件选',
  'devices.key.passphrase': '口令',
  'devices.key.passphrase.hint': '钥匙没加口令就留空。口令和私钥一起存在系统的安全存储里',
  'devices.key.doImport': '导入',
  'devices.key.locked': '这把钥匙加了口令，填上口令再导入。',
  'devices.key.invalid': '不是能用的私钥，或者口令不对。只认 OpenSSH 格式的 Ed25519、RSA、ECDSA。',
  'devices.key.failed': '没做成：{reason}',

  'devices.check': '连上去看看',
  'devices.check.hint': '只是看一眼对面有什么，不启动任何东西。',
  'devices.check.service': '设备服务 {version}',
  'devices.check.codex': '只有 codex {version}',
  'devices.check.harnesses': '可用的 harness：{names}',
  'devices.check.noHarness': '现在没有可用的 harness。连上之后在设备详情里看原因。',
  'devices.check.idle': '服务现在没在跑，连的时候会把它启动起来。',
  'devices.check.codexOnly': '那台机器上只有 codex，没有设备服务：只能用 codex 这一个 harness。',
  'devices.submit': '添加',

  'devices.trust.title': '第一次连这台主机',
  'devices.trust.detail':
    '{host} 的主机钥匙（{type}）指纹是：\n\n{fingerprint}\n\n可以在那台机器上运行 {command} 核对，对得上再信任。',
  'devices.trust.yes': '信任',
  'devices.trust.changed.title': '主机钥匙变了',
  'devices.trust.changed.detail':
    '{host} 现在给的指纹是：\n\n{fingerprint}\n\n上次信任的是：\n\n{old}\n\n可能是那台机器重装过系统，也可能有人在冒充它。确认是前一种再信任新的。',
  'devices.trust.changed.yes': '信任新的',
  'devices.trust.same': '主机钥匙没变：{fingerprint}',
  'devices.trust.failed': '读不到主机钥匙：{reason}',
  'devices.retrust': '重新信任主机钥匙',

  'devices.why.hostKeyUnknown':
    '这台主机的钥匙还没有信任过。点“重新信任主机钥匙”，核对指纹之后信任它。',
  'devices.why.hostKeyChanged':
    '这台主机的钥匙和上次信任的不一样：可能是它重装过系统，也可能有人在冒充它。确认清楚之前不要连；确认之后点“重新信任主机钥匙”。',
  'devices.why.auth':
    '登录被拒绝了。确认这台手机的公钥已经加到那台机器上这个用户的 ~/.ssh/authorized_keys 里，用户名也没填错。',
  'devices.why.keyMissing': '这台手机上已经没有这台设备用的钥匙了。去掉这台设备，再重新加一次。',
  'devices.why.keyBroken': '这把钥匙用不了。去掉这台设备，换一把钥匙重新加。',

  'devices.detail.connection': '连接',
  'devices.detail.user': '用户',
  'devices.detail.key': '钥匙',
  'devices.detail.hostKey': '主机指纹',
  'devices.detail.hostKey.none': '还没信任过',
  'devices.detail.peer.unknown': '还没连上过',
  'devices.detail.noManage': '这台设备没有设置接口，harness 只能在这里看。',

  'devices.manage.enable': '启用',
  'devices.manage.settings': '{count} 项设置',
  'devices.manage.env': '环境变量在电脑上的 Litch 里改。',

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
    'Add a computer that has the adapter (codex-harness-adapter) or codex installed. The phone connects to it over SSH.',
  'devices.menu.detail': 'Device details',
  'devices.menu.sessions': 'Sessions',
  'devices.stale': 'From last time',
  'devices.more': 'More',

  'devices.where': 'Where to connect',
  'devices.field.host': 'Host name or IP',
  'devices.field.host.hint':
    'The phone must be able to reach it: same local network, or a mesh such as Tailscale',
  'devices.field.port': 'Port',
  'devices.field.user': 'User',
  'devices.field.name': 'Display name',
  'devices.field.name.hint': 'Leave empty to use the host name',
  'devices.field.missing': 'Host, user and key are all required',

  'devices.key': 'Key',
  'devices.key.none': 'No keys yet. Generate a new one, or import a private key you already have.',
  'devices.key.generate': 'Generate a key',
  'devices.key.import': 'Import a private key',
  'devices.key.generated': 'Generated on this phone',
  'devices.key.imported': 'Imported',
  'devices.key.public': 'Public key',
  'devices.key.copy': 'Copy public key',
  'devices.key.copied': 'Copied',
  'devices.key.authorize':
    'Add the public key to ~/.ssh/authorized_keys for this user on that machine. Run this there:',
  'devices.key.copyCommand': 'Copy this command',
  'devices.key.paste': 'Private key',
  'devices.key.paste.hint':
    'The whole block starting with -----BEGIN; OpenSSH Ed25519, RSA or ECDSA',
  'devices.key.pickFile': 'Pick a file',
  'devices.key.passphrase': 'Passphrase',
  'devices.key.passphrase.hint':
    'Leave empty if the key has none. It is kept with the key in the system secure storage',
  'devices.key.doImport': 'Import',
  'devices.key.locked': 'This key has a passphrase. Enter it and import again.',
  'devices.key.invalid':
    'Not a usable private key, or the passphrase is wrong. OpenSSH Ed25519, RSA and ECDSA keys are supported.',
  'devices.key.failed': 'Did not work: {reason}',

  'devices.check': 'Check the machine',
  'devices.check.hint': 'Only looks at what is there. Nothing is started.',
  'devices.check.service': 'Device service {version}',
  'devices.check.codex': 'Only codex {version}',
  'devices.check.harnesses': 'Harnesses available: {names}',
  'devices.check.noHarness':
    'No harness is available right now. Once connected, the device details say why.',
  'devices.check.idle': 'The service is not running now. It will be started when connecting.',
  'devices.check.codexOnly':
    'That machine only has codex, no device service: codex is the only harness.',
  'devices.submit': 'Add',

  'devices.trust.title': 'First connection to this host',
  'devices.trust.detail':
    'The host key ({type}) of {host} has the fingerprint:\n\n{fingerprint}\n\nYou can check it by running {command} on that machine. Trust it only if they match.',
  'devices.trust.yes': 'Trust',
  'devices.trust.changed.title': 'The host key changed',
  'devices.trust.changed.detail':
    '{host} now presents the fingerprint:\n\n{fingerprint}\n\nThe one trusted before was:\n\n{old}\n\nThe machine may have been reinstalled, or someone may be impersonating it. Trust the new one only if you are sure it is the former.',
  'devices.trust.changed.yes': 'Trust the new key',
  'devices.trust.same': 'The host key has not changed: {fingerprint}',
  'devices.trust.failed': 'Could not read the host key: {reason}',
  'devices.retrust': 'Trust the host key again',

  'devices.why.hostKeyUnknown':
    'The key of this host has not been trusted yet. Tap “Trust the host key again”, check the fingerprint and trust it.',
  'devices.why.hostKeyChanged':
    'The key of this host differs from the one trusted before: the machine may have been reinstalled, or someone may be impersonating it. Do not connect until you know which; then tap “Trust the host key again”.',
  'devices.why.auth':
    "Login was refused. Make sure this phone's public key is in ~/.ssh/authorized_keys for this user on that machine, and that the user name is right.",
  'devices.why.keyMissing':
    'The key for this device is no longer on this phone. Remove the device and add it again.',
  'devices.why.keyBroken':
    'This key cannot be used. Remove the device and add it again with another key.',

  'devices.detail.connection': 'Connection',
  'devices.detail.user': 'User',
  'devices.detail.key': 'Key',
  'devices.detail.hostKey': 'Host fingerprint',
  'devices.detail.hostKey.none': 'Not trusted yet',
  'devices.detail.peer.unknown': 'Never connected',
  'devices.detail.noManage':
    'This device has no settings interface; harnesses are shown read-only.',

  'devices.manage.enable': 'Enabled',
  'devices.manage.settings': '{count} settings',
  'devices.manage.env': 'Environment variables are edited in Litch on a computer.',

  'devices.color.green': 'Green',
  'devices.color.orange': 'Orange',
  'devices.color.blue': 'Blue',
  'devices.color.violet': 'Violet',
  'devices.color.yellow': 'Yellow',
  'devices.color.brown': 'Brown',
  'devices.color.red': 'Red',
  'devices.color.slate': 'Slate',
}
