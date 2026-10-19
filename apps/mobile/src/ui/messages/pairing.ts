// 手机端自己的文案：扫码绑定（加设备页的“扫码添加”、扫码页、确认、登记、删设备时撤钥匙）。键加前缀 "pair."。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'pair.entry': '扫码添加',
  'pair.entry.hint':
    '在电脑上 Litch 的设备详情里点“在手机上使用…”，扫出现的二维码。不用复制公钥，也不用核对主机指纹。',

  'pair.title': '扫码添加',
  'pair.camera.why': '用相机扫电脑上的配对二维码。只在这一页用，不拍照、不录像。',
  'pair.camera.allow': '允许使用相机',
  'pair.camera.denied': '没有相机权限。可以到系统设置里给 Litch 打开相机，或者在下面粘贴配对文本。',
  'pair.camera.settings': '打开系统设置',
  'pair.paste': '配对文本',
  'pair.paste.hint': '电脑上“复制配对文本”得到的那一段，以 LITCHPAIR1: 开头',
  'pair.paste.go': '用这段文本',
  'pair.paste.clipboard': '从剪贴板粘贴',
  'pair.notPair': '这不是 Litch 的配对文本。',

  'pair.confirm': '要添加的设备',
  'pair.confirm.name': '名字',
  'pair.confirm.host': '主机名或 IP',
  'pair.confirm.port': '端口',
  'pair.confirm.user': '用户',
  'pair.confirm.fixed':
    '这几项是电脑上出码时定的，这里不能改。手机连不到这个地址的话，到电脑上改好地址再重新出码。',
  'pair.expired': '二维码已经过期了，请在电脑上重新生成。',
  'pair.add': '添加',
  'pair.again': '重新扫码',

  'pair.step.key': '正在生成这台手机的钥匙…',
  'pair.step.enroll': '到电脑上点“允许”',
  'pair.code': '确认码',
  'pair.code.hint': '电脑上显示的确认码和这里一样，再点允许。最多等 2 分钟。',
  'pair.step.check': '已绑定，正在用这台手机自己的钥匙连上去…',
  'pair.step.add': '正在添加…',

  'pair.failed': '没有添加成功',
  'pair.why.expired': '二维码已经过期或者被取消了，请在电脑上重新生成。',
  'pair.why.used': '这个二维码已经用过了，请在电脑上重新生成。',
  'pair.why.rejected': '电脑上拒绝了。',
  'pair.why.timeout': '电脑上一直没有确认。请在电脑上重新出码再试。',
  'pair.why.invalid': '那台机器没收下这台手机的钥匙（格式不对）。',
  'pair.why.keysFile':
    '那台机器的钥匙文件改不了：可能由别的工具管着，或者权限不对。请改用手动添加。',
  'pair.why.unavailable': '那台机器上的设备服务没在运行。请在电脑上重新出码再试。',
  'pair.why.refused': '一次性钥匙不被接受：二维码可能已经用过或过期了。请在电脑上重新生成。',
  'pair.why.hostKey': '手机连到的不是这台机器（主机指纹对不上），没有继续。',
  'pair.why.unreachable':
    '连不上 {host}:{port}。手机连不到这个地址的话，在电脑上改地址后重新出码。',
  'pair.why.noAnswer':
    '登进去了，但那台机器没有给出登记结果。它上面的适配器可能太旧，先在电脑上升级设备服务。',
  'pair.why.unknown': '出了意外。',
  'pair.detail': '详情：{detail}',

  'pair.revoke': '同时在这台机器上撤掉这部手机的钥匙',
  'pair.revoke.done': '已经移除',
  'pair.revoke.offline':
    '这台设备现在没连上，那台机器上这部手机的钥匙没有撤掉。需要的话到电脑上 Litch 的设备详情里撤销。',
  'pair.revoke.failed':
    '那台机器上这部手机的钥匙没有撤掉：{reason}。需要的话到电脑上 Litch 的设备详情里撤销。',
  'pair.ok': '知道了',
} satisfies Record<`pair.${string}`, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'pair.entry': 'Scan to add',
  'pair.entry.hint':
    'In Litch on your computer, open the device details, choose “Use on phone…” and scan the QR code. No public key to copy, no fingerprint to check.',

  'pair.title': 'Scan to add',
  'pair.camera.why':
    'The camera is used to scan the pairing QR code on your computer, only on this page. Nothing is photographed or recorded.',
  'pair.camera.allow': 'Allow camera',
  'pair.camera.denied':
    'No camera permission. Turn on the camera for Litch in system settings, or paste the pairing text below.',
  'pair.camera.settings': 'Open system settings',
  'pair.paste': 'Pairing text',
  'pair.paste.hint': 'What “Copy pairing text” gives on the computer; it starts with LITCHPAIR1:',
  'pair.paste.go': 'Use this text',
  'pair.paste.clipboard': 'Paste from clipboard',
  'pair.notPair': 'This is not a Litch pairing text.',

  'pair.confirm': 'Device to add',
  'pair.confirm.name': 'Name',
  'pair.confirm.host': 'Host name or IP',
  'pair.confirm.port': 'Port',
  'pair.confirm.user': 'User',
  'pair.confirm.fixed':
    'These were set on the computer when the code was made and cannot be changed here. If the phone cannot reach this address, fix it on the computer and make a new code.',
  'pair.expired': 'The QR code has expired. Make a new one on the computer.',
  'pair.add': 'Add',
  'pair.again': 'Scan again',

  'pair.step.key': 'Generating a key for this phone…',
  'pair.step.enroll': 'Tap “Allow” on the computer',
  'pair.code': 'Confirmation code',
  'pair.code.hint': 'Allow only if the computer shows the same code. It waits for up to 2 minutes.',
  'pair.step.check': 'Paired. Connecting with this phone’s own key…',
  'pair.step.add': 'Adding…',

  'pair.failed': 'Not added',
  'pair.why.expired': 'The QR code has expired or was cancelled. Make a new one on the computer.',
  'pair.why.used': 'This QR code has already been used. Make a new one on the computer.',
  'pair.why.rejected': 'It was rejected on the computer.',
  'pair.why.timeout':
    'Nobody confirmed on the computer. Make a new code on the computer and try again.',
  'pair.why.invalid': 'That machine did not accept this phone’s key (bad format).',
  'pair.why.keysFile':
    'The key file on that machine cannot be changed: another tool may manage it, or its permissions are wrong. Add the device manually instead.',
  'pair.why.unavailable':
    'The device service on that machine is not running. Make a new code on the computer and try again.',
  'pair.why.refused':
    'The one-time key was refused: the QR code may have been used or expired. Make a new one on the computer.',
  'pair.why.hostKey':
    'The phone reached a different machine (the host fingerprint does not match), so it stopped.',
  'pair.why.unreachable':
    'Cannot reach {host}:{port}. If the phone cannot reach this address, change it on the computer and make a new code.',
  'pair.why.noAnswer':
    'Logged in, but that machine gave no pairing result. Its adapter may be too old; upgrade the device service from the computer first.',
  'pair.why.unknown': 'Something unexpected happened.',
  'pair.detail': 'Details: {detail}',

  'pair.revoke': 'Also remove this phone’s key from that machine',
  'pair.revoke.done': 'Removed',
  'pair.revoke.offline':
    'The device is not connected, so this phone’s key is still on that machine. Revoke it from the device details in Litch on your computer if needed.',
  'pair.revoke.failed':
    'This phone’s key is still on that machine: {reason}. Revoke it from the device details in Litch on your computer if needed.',
  'pair.ok': 'OK',
}
