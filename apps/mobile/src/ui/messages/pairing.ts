// 手机端自己的文案：扫码绑定（加设备页的“扫码添加”、扫码页、确认、登记、删设备时撤钥匙）。键加前缀 "pair."。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'pair.entry': '扫码添加',
  'pair.entry.hint':
    '在电脑上 Litch 的设备详情中点击“在手机上使用…”，扫描显示的二维码。无需复制公钥或核对主机指纹。',

  'pair.title': '扫码添加',
  'pair.camera.why': '使用相机扫描电脑上的配对二维码，仅在此页面使用，不拍照、不录像。',
  'pair.camera.allow': '允许使用相机',
  'pair.camera.denied': '没有相机权限。可在系统设置中为 Litch 开启相机，或在下方粘贴配对文本。',
  'pair.camera.settings': '打开系统设置',
  'pair.paste': '配对文本',
  'pair.paste.hint': '电脑上“复制配对文本”得到的内容，以 LITCHPAIR1: 开头',
  'pair.paste.go': '使用此文本',
  'pair.paste.clipboard': '从剪贴板粘贴',
  'pair.notPair': '不是 Litch 的配对文本。',

  'pair.confirm': '要添加的设备',
  'pair.confirm.name': '名称',
  'pair.confirm.host': '主机名或 IP',
  'pair.confirm.port': '端口',
  'pair.confirm.user': '用户',
  'pair.confirm.fixed':
    '以上各项在电脑上生成二维码时已确定，此处无法修改。如果手机无法访问该地址，请在电脑上修改地址后重新生成二维码。',
  'pair.expired': '二维码已过期，请在电脑上重新生成。',
  'pair.add': '添加',
  'pair.again': '重新扫码',

  'pair.step.key': '正在为此手机生成密钥…',
  'pair.step.enroll': '请在电脑上点击“允许”',
  'pair.code': '确认码',
  'pair.code.hint': '确认电脑上显示的确认码与此处一致后再点击允许。最多等待 2 分钟。',
  'pair.step.check': '已绑定，正在使用此手机的密钥连接…',
  'pair.step.add': '正在添加…',

  'pair.failed': '添加失败',
  'pair.why.expired': '二维码已过期或已取消，请在电脑上重新生成。',
  'pair.why.used': '此二维码已使用过，请在电脑上重新生成。',
  'pair.why.rejected': '电脑端已拒绝。',
  'pair.why.timeout': '电脑端未确认。请在电脑上重新生成二维码后重试。',
  'pair.why.invalid': '远程设备未接受此手机的密钥（格式错误）。',
  'pair.why.keysFile':
    '无法修改远程设备的密钥文件：可能由其他工具管理，或权限不正确。请改用手动添加。',
  'pair.why.unavailable': '远程设备上的设备服务未运行。请在电脑上重新生成二维码后重试。',
  'pair.why.refused': '一次性密钥被拒绝：二维码可能已使用或已过期。请在电脑上重新生成。',
  'pair.why.hostKey': '手机连接的不是该设备（主机指纹不一致），已停止。',
  'pair.why.unreachable':
    '无法连接 {host}:{port}。如果手机无法访问该地址，请在电脑上修改地址后重新生成二维码。',
  'pair.why.noAnswer':
    '已登录，但远程设备未返回登记结果。其适配器可能过旧，请先在电脑上升级设备服务。',
  'pair.why.unknown': '发生意外错误。',
  'pair.why.tailscaleOff':
    '无法连接 {host}:{port}：手机上的 Tailscale 可能未打开或未登录。打开并登录后重新扫码。',
  'pair.why.denied':
    'Tailscale 不允许此手机登录：请检查 Tailscale ACL 是否允许此手机以该用户登录。',
  'pair.why.verify': 'Tailscale 要求在浏览器中完成一次验证。打开验证页面完成后点重试。',
  'pair.verify.open': '打开验证页面',
  'pair.retry': '重试',
  'pair.tailscale':
    '此设备经 Tailscale SSH 连接，请先打开手机上的 Tailscale 并登录。能否登录由 Tailscale ACL 决定。',
  'pair.detail': '详情：{detail}',

  'pair.revoke': '同时在远程设备上撤销此手机的密钥',
  'pair.revoke.done': '已移除',
  'pair.revoke.offline':
    '设备当前未连接，此手机的密钥未从远程设备撤销。如有需要，请在电脑上 Litch 的设备详情中撤销。',
  'pair.revoke.failed':
    '此手机的密钥未能从远程设备撤销：{reason}。如有需要，请在电脑上 Litch 的设备详情中撤销。',
  'pair.ok': '知道了',
} satisfies Record<`pair.${string}`, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'pair.entry': 'Scan to add',
  'pair.entry.hint':
    'In Litch on your computer, open the device details, choose “Use on phone…” and scan the QR code. No public key to copy or fingerprint to check.',

  'pair.title': 'Scan to add',
  'pair.camera.why':
    'Used only on this page to scan the pairing QR code on your computer. Nothing is photographed or recorded.',
  'pair.camera.allow': 'Allow camera',
  'pair.camera.denied':
    'No camera permission. Turn on the camera for Litch in system settings, or paste the pairing text below.',
  'pair.camera.settings': 'Open system settings',
  'pair.paste': 'Pairing text',
  'pair.paste.hint': 'From “Copy pairing text” on the computer. Starts with LITCHPAIR1:',
  'pair.paste.go': 'Use this text',
  'pair.paste.clipboard': 'Paste from clipboard',
  'pair.notPair': 'This isn’t a Litch pairing text.',

  'pair.confirm': 'Device to add',
  'pair.confirm.name': 'Name',
  'pair.confirm.host': 'Host name or IP',
  'pair.confirm.port': 'Port',
  'pair.confirm.user': 'User',
  'pair.confirm.fixed':
    'Set on the computer when the code was created and can’t be changed here. If the phone can’t reach this address, change it on the computer and create a new code.',
  'pair.expired': 'The QR code has expired. Create a new one on the computer.',
  'pair.add': 'Add',
  'pair.again': 'Scan again',

  'pair.step.key': 'Generating a key for this phone…',
  'pair.step.enroll': 'Tap “Allow” on the computer',
  'pair.code': 'Confirmation code',
  'pair.code.hint': 'Allow only if the computer shows the same code. Waits up to 2 minutes.',
  'pair.step.check': 'Paired. Connecting with this phone’s key…',
  'pair.step.add': 'Adding…',

  'pair.failed': 'Couldn’t add device',
  'pair.why.expired': 'The QR code has expired or was cancelled. Create a new one on the computer.',
  'pair.why.used': 'This QR code has already been used. Create a new one on the computer.',
  'pair.why.rejected': 'Rejected on the computer.',
  'pair.why.timeout': 'Not confirmed on the computer. Create a new code and try again.',
  'pair.why.invalid': 'The remote device didn’t accept this phone’s key (invalid format).',
  'pair.why.keysFile':
    'The key file on the remote device can’t be changed: another tool may manage it, or its permissions are wrong. Add the device manually instead.',
  'pair.why.unavailable':
    'The device service on the remote device isn’t running. Create a new code on the computer and try again.',
  'pair.why.refused':
    'The one-time key was refused. The QR code may have been used or expired. Create a new one on the computer.',
  'pair.why.hostKey':
    'The phone reached a different device (host fingerprint doesn’t match), so it stopped.',
  'pair.why.unreachable':
    'Can’t reach {host}:{port}. If the phone can’t reach this address, change it on the computer and create a new code.',
  'pair.why.noAnswer':
    'Signed in, but the remote device returned no pairing result. Its adapter may be outdated. Update the device service from the computer first.',
  'pair.why.unknown': 'Something unexpected happened.',
  'pair.why.tailscaleOff':
    'Can’t reach {host}:{port}. Tailscale on this phone may be off or signed out. Turn it on, sign in and scan again.',
  'pair.why.denied':
    'Tailscale doesn’t let this phone log in. Check that your Tailscale ACL allows this phone to log in as this user.',
  'pair.why.verify':
    'Tailscale requires a check in the browser. Open the verification page, finish it, then retry.',
  'pair.verify.open': 'Open verification page',
  'pair.retry': 'Retry',
  'pair.tailscale':
    'This device is reached over Tailscale SSH. Turn on Tailscale on this phone and sign in first. Your Tailscale ACL decides whether it can log in.',
  'pair.detail': 'Details: {detail}',

  'pair.revoke': 'Also revoke this phone’s key on the remote device',
  'pair.revoke.done': 'Removed',
  'pair.revoke.offline':
    'The device isn’t connected, so this phone’s key wasn’t revoked. If needed, revoke it from the device details in Litch on your computer.',
  'pair.revoke.failed':
    'This phone’s key wasn’t revoked: {reason}. If needed, revoke it from the device details in Litch on your computer.',
  'pair.ok': 'OK',
}
