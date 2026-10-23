// 扫码绑定手机的英文文案。键必须和 zh-CN-pairing.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhPairing } from './zh-CN-pairing.ts'

export const enPairing: Record<keyof typeof zhPairing, Entry> = {
  'pairing.use': 'Use on phone…',
  'pairing.title': 'Use {name} on your phone',
  'pairing.intro':
    'In the Litch phone app, go to Add device → Scan to add and scan this code. The phone creates its own key; this computer’s key never leaves it.',
  'pairing.shared':
    'Don’t open this while sharing your screen. Anyone who sees the code can request pairing (you still have to allow it here).',
  'pairing.starting': 'Preparing a one-time key on the device and testing it…',
  'pairing.address': 'Address for the phone',
  'pairing.address.note':
    'Only changes the address given to the phone, not this device’s connection settings here.',
  'pairing.field.name': 'Name',
  'pairing.field.host': 'Host name or IP',
  'pairing.field.port': 'Port',
  'pairing.field.user': 'User',
  'pairing.bad.name': 'Name can’t be empty or longer than 64 characters',
  'pairing.bad.host':
    'Host can’t be empty, contain spaces or start with a dash. Enter the user name in its own field',
  'pairing.bad.port': 'Port must be a whole number from 1 to 65535',
  'pairing.bad.user': 'User can’t be empty, contain spaces or start with a dash',
  'pairing.original': 'Original: {address}',
  'pairing.restore': 'Restore original',
  'pairing.host.pick': 'Tailscale',
  'pairing.host.choose': 'Use this device’s Tailscale IP, full name or short name',
  'pairing.host.ip': 'IP',
  'pairing.host.long': 'Full name',
  'pairing.host.short': 'Short name',
  'pairing.expires': 'New code in {time}',
  'pairing.refreshing': 'Generating a new code…',
  'pairing.copy': 'Copy pairing text',
  'pairing.copied': 'Pairing text copied. Paste it on the phone’s scan screen.',
  'pairing.copyFailed': 'Couldn’t copy: {reason}',
  'pairing.qr': 'Pairing QR code',
  'pairing.state.waiting': 'Waiting for the phone to scan…',
  'pairing.state.requested': 'Phone “{name}” is requesting to pair',
  'pairing.code': 'Confirmation code',
  'pairing.code.note':
    'The phone shows a code too. Allow only if they match. If not, reject — someone else may have scanned this code.',
  'pairing.allow': 'Allow',
  'pairing.reject': 'Reject',
  'pairing.state.done': '“{name}” is paired. The phone will connect with its own key.',
  'pairing.state.rejected': 'Pairing rejected. This code is no longer valid.',
  'pairing.state.cancelled': 'This code is no longer valid.',
  'pairing.state.expired': 'This code has expired.',
  'pairing.again': 'New code',
  'pairing.done': 'Done',
  'pairing.close': 'Close',
  'pairing.failed': 'Failed: {reason}',
  'pairing.fail.title': 'Can’t generate a code',
  'pairing.fail.keysFile':
    'Can’t modify the key file on this device (~/.ssh/authorized_keys). It may be a symlink, read-only, or managed by another tool. Add this device manually on the phone.',
  'pairing.fail.noHostKey':
    'Couldn’t read this device’s host keys (no /etc/ssh/ssh_host_*_key.pub), so the phone can’t verify it’s connecting to this device.',
  'pairing.fail.hostKeyMismatch':
    'The host key this computer sees differs from the one the device reports, likely due to a port forward or jump host. For security, no code is generated.',
  'pairing.fail.selfTest':
    'The one-time key couldn’t log in: sshd may ignore authorized_keys, allow only some users, or require a second factor. Add this device manually on the phone.',
  'pairing.fail.sshOff': 'This computer isn’t running an SSH server, so the phone can’t connect.',
  'pairing.fail.sshOff.macos':
    'Turn on Remote Login in System Settings → General → Sharing, make sure your user is allowed, then retry.',
  'pairing.fail.sshOff.windows':
    'Install and start “OpenSSH Server” in Settings → System → Optional features, then retry. Administrator accounts must be added manually for now.',
  'pairing.fail.sshOff.linux': 'Install and start sshd (for example openssh-server), then retry.',
  'pairing.fail.unsupported':
    'The service on this device doesn’t support phone pairing. Update the adapter on the device.',
  'pairing.fail.offline': 'Device not connected. Try again once it connects.',
  'pairing.fail.said': 'ssh output',
  'pairing.retry': 'Retry',
  'pairing.fail.tailscale':
    'The address used for the check is handled by Tailscale SSH, which ignores authorized_keys, so the one-time key’s forced command has no effect. Generate the code the Tailscale way instead.',
  'pairing.fail.enrollTest':
    'The check before generating the code failed: this computer couldn’t log in to this address over Tailscale SSH with a temporary key and run the enroll command. See the output below; if your Tailscale ACL doesn’t let this computer in, the phone usually can’t log in either.',
  'pairing.useTailscale': 'Use Tailscale instead',
  'pairing.fail.verify':
    'Tailscale requires a check in the browser (ACL check mode). Open the verification page, finish it, then retry.',
  'pairing.fail.verify.open': 'Open verification page',
  'pairing.tailscale.note':
    'Tailscale SSH handles this address: the phone needs Tailscale installed and signed in, and your Tailscale ACL decides whether it can log in. Any tailnet device the ACL allows can log in as {user} without a key; revoking in Litch can’t stop them.',
  'pairing.tailscale.phone':
    'This computer being able to log in doesn’t mean the phone can: ACLs can differ per device.',
  'pairing.tailscale.unchecked':
    'This computer can’t reach this address, so the code wasn’t checked.',
  'phones.tailscale':
    'This device uses Tailscale SSH, so revoking only removes the key. To block a phone, change your ACL or remove the device in the Tailscale admin console.',
  'phones.revoke.askTailscale':
    'Revoke the key of “{name}”? This device uses Tailscale SSH: revoking only removes the key, and the phone can still log in through Tailscale. To block it, change your ACL or remove the device in the Tailscale admin console.',
  'phones.title': 'Phones',
  'phones.count': (args) => `${args.count} ${Number(args.count) === 1 ? 'phone' : 'phones'}`,
  'phones.none': 'None',
  'phones.empty': 'No phones paired with this device.',
  'phones.loading': 'Loading…',
  'phones.added': 'Paired {date}',
  'phones.addedUnknown': 'Pairing date unknown',
  'phones.revoke': 'Revoke',
  'phones.revoke.ask':
    'Revoke the key of “{name}”? That phone will no longer be able to connect to this device.',
  'phones.revoked': 'Revoked the key of “{name}”.',
  'phones.failed': 'Failed: {reason}',
  'phones.upgrade':
    'The service on this device doesn’t support phone pairing. Update the adapter on the device to generate codes and manage phones here.',
  'phones.windowsAdmin':
    'Phone pairing isn’t available yet for Windows administrator accounts: OpenSSH only reads administrators_authorized_keys for them, and changing it requires admin rights. You can add the phone’s public key to that file manually.',
  'phones.offline': 'Device not connected. Paired phones appear once it connects.',
}
