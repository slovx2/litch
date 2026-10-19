// 扫码绑定手机的英文文案。键必须和 zh-CN-pairing.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhPairing } from './zh-CN-pairing.ts'

export const enPairing: Record<keyof typeof zhPairing, Entry> = {
  'pairing.use': 'Use on phone…',
  'pairing.title': 'Use {name} on your phone',
  'pairing.intro':
    'Scan this code with “Scan to add” under Add device in the Litch phone app. The phone makes its own key; this computer’s key never leaves it.',
  'pairing.shared':
    'Don’t open this while sharing your screen: anyone who captures the code can ask to enroll (you still have to allow it here).',
  'pairing.starting': 'Preparing a one-time key on the device and trying it once…',
  'pairing.address': 'Address for the phone',
  'pairing.address.note':
    'The phone connects to this. Changes apply only to the phone’s copy, not to this device’s connection settings here.',
  'pairing.field.name': 'Name',
  'pairing.field.host': 'Host name or IP',
  'pairing.field.port': 'Port',
  'pairing.field.user': 'User',
  'pairing.bad.name': 'Name can’t be empty and is at most 64 characters',
  'pairing.bad.host':
    'Host can’t be empty, contain spaces or start with a dash; put the user name in its own field',
  'pairing.bad.port': 'Port is a whole number from 1 to 65535',
  'pairing.bad.user': 'User can’t be empty, contain spaces or start with a dash',
  'pairing.original': 'Original: {address}',
  'pairing.restore': 'Restore original',
  'pairing.expires': 'New code in {time}',
  'pairing.refreshing': 'Making a new code…',
  'pairing.copy': 'Copy pairing text',
  'pairing.copied': 'Pairing text copied. You can paste it on the phone’s scan screen.',
  'pairing.copyFailed': 'Couldn’t copy: {reason}',
  'pairing.qr': 'Pairing QR code',
  'pairing.state.waiting': 'Waiting for the phone to scan…',
  'pairing.state.requested': 'Phone “{name}” wants to enroll',
  'pairing.code': 'Confirmation code',
  'pairing.code.note':
    'The phone shows a code too. Allow only if both match; if they don’t, reject — someone else may have scanned this code.',
  'pairing.allow': 'Allow',
  'pairing.reject': 'Reject',
  'pairing.state.done': '“{name}” is enrolled. The phone will now connect with its own key.',
  'pairing.state.rejected': 'Enrollment rejected. This code is void.',
  'pairing.state.cancelled': 'This code is void.',
  'pairing.state.expired': 'This code has expired.',
  'pairing.again': 'New code',
  'pairing.done': 'Done',
  'pairing.close': 'Close',
  'pairing.failed': 'Didn’t work: {reason}',
  'pairing.fail.title': 'Can’t make a code',
  'pairing.fail.keysFile':
    'The key file on this device (~/.ssh/authorized_keys) can’t be changed: it may be a symlink, read-only, or managed by another tool. Add this device on the phone by hand instead.',
  'pairing.fail.noHostKey':
    'Couldn’t read this device’s host keys (no /etc/ssh/ssh_host_*_key.pub), so the phone couldn’t verify it’s talking to this machine.',
  'pairing.fail.hostKeyMismatch':
    'The host key this computer connects to differs from the one the device reports — probably a port forward or jump host in between. No code, to stay safe.',
  'pairing.fail.selfTest':
    'The one-time key couldn’t log in: sshd may ignore authorized_keys, allow only some users, or require a second factor. Add this device on the phone by hand instead.',
  'pairing.fail.sshOff': 'This computer isn’t running an SSH server, so the phone can’t connect.',
  'pairing.fail.sshOff.macos':
    'Turn on Remote Login in System Settings → General → Sharing, make sure your user is allowed, then retry.',
  'pairing.fail.sshOff.windows':
    'Install and start “OpenSSH Server” in Settings → System → Optional features, then retry. Administrator accounts must be added by hand for now.',
  'pairing.fail.sshOff.linux': 'Install and start sshd (for example openssh-server), then retry.',
  'pairing.fail.unsupported':
    'The service on this device doesn’t support phone pairing. Update the adapter on it to use it.',
  'pairing.fail.offline': 'The device isn’t connected. Try again once it is.',
  'pairing.fail.said': 'What ssh said',
  'pairing.retry': 'Retry',
  'phones.title': 'Phones',
  'phones.count': (args) => `${args.count} ${Number(args.count) === 1 ? 'phone' : 'phones'}`,
  'phones.none': 'None',
  'phones.empty': 'No phone is enrolled on this device yet.',
  'phones.loading': 'Loading…',
  'phones.added': 'Enrolled {date}',
  'phones.addedUnknown': 'Enrollment date unknown',
  'phones.revoke': 'Revoke',
  'phones.revoke.ask':
    'Revoke the key of “{name}”? That phone won’t be able to connect to this device.',
  'phones.revoked': 'Revoked the key of “{name}”.',
  'phones.failed': 'Didn’t work: {reason}',
  'phones.upgrade':
    'The service on this device doesn’t support phone pairing. After updating the adapter on it you can make codes and manage phones here.',
  'phones.windowsAdmin':
    'Phone pairing isn’t available for an administrator account on Windows yet: OpenSSH only reads administrators_authorized_keys for administrators, and changing it needs admin rights. You can add the phone’s public key to that file by hand.',
  'phones.offline': 'The device isn’t connected. Its phones show up once it is.',
}
