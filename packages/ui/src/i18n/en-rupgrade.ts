// 远程设备一键升级的英文文案。键必须和 zh-CN-rupgrade.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhRupgrade } from './zh-CN-rupgrade.ts'

export const enRupgrade: Record<keyof typeof zhRupgrade, Entry> = {
  'service.app': 'App version',
  'service.installed': 'Installed',
  'service.remote.flag': 'The device service is older than the app',
  'service.remote.sum.stale': 'Older than the app',
  'service.remote.sum.waiting': 'Waiting to switch',
  'service.remote.older': 'The running device service is {from}, older than the app’s {to}.',
  'service.remote.older.unknown':
    'The running device service doesn’t report its version and is treated as older than the app’s {to}.',
  'service.remote.swapOnly':
    '{installed} is installed on this device; the old version keeps running until the service restarts.',
  'service.remote.unknownMethod':
    'Litch can’t tell how the adapter was installed on this device. Upgrade it manually:',
  'service.remote.managedSwap':
    'This service runs in the foreground or under a service manager. Restart it the way you started it to switch to the new version:',
  'service.remote.upgrade': 'Upgrade',
  'service.remote.swap': 'Switch to new version',
  'service.remote.installing': 'Installing {to} on this device…',
  'service.remote.stopping': 'New version installed. Asking the device service to stop when idle…',
  'service.remote.forcing': 'Stopping the device service…',
  'service.remote.reconnecting': 'Device service stopped. Reconnecting…',
  'service.remote.waiting':
    '{to} is installed. The device service is busy and switches over once it’s idle:',
  'service.remote.waiting.next':
    'Litch tries again on every connection and every 5 minutes, and stops waiting when you quit the app.',
  'service.remote.retry': 'Try Now',
  'service.remote.checking': 'Checking…',
  'service.remote.force': 'Switch Now',
  'service.remote.restart':
    '{to} is installed. This service runs in the foreground or under a service manager; restart it the way you started it:',
  'service.remote.done': 'Switched to the new version: {from} → {to}.',
  'service.remote.done.plain': 'Switched to the new version {to}.',
  'service.remote.failed.connect': 'Couldn’t reach this device, so the upgrade didn’t finish:',
  'service.remote.failed.fetch':
    'This device has neither curl nor wget, so the install script can’t be downloaded.',
  'service.remote.failed.download':
    'Downloading the install script failed. This device may not be able to reach GitHub.',
  'service.remote.failed.install': 'The install script didn’t finish.',
  'service.remote.failed.brew': 'brew upgrade didn’t finish.',
  'service.remote.failed.behind':
    'Homebrew still installed {installed}; the formula hasn’t reached {to} yet. Try again later, or use the install script instead.',
  'service.remote.failed.verify': 'The installed version couldn’t be confirmed.',
  'service.remote.failed.unsupported':
    'The new version is installed, but the running service doesn’t support stop requests. End it once by hand:',
  'service.remote.failed.legacy':
    'The new version is installed, but an older service without the aggregate endpoint is running. Restart it by hand:',
  'service.remote.failed.stop': 'The new version is installed, but the device service didn’t stop.',
  'service.remote.failed.stale':
    'The device service stopped and reconnected, but the old version is still running.',
  'service.remote.again': 'Retry',
  'service.remote.step.script': 'Install {to} with the install script:',
  'service.remote.step.brew': 'If you installed with Homebrew:',
  'service.remote.step.brew.known': 'Upgrade with Homebrew:',
  'service.remote.step.from':
    'If this device can’t reach GitHub, download the archive and checksum list from the releases page on another machine, copy them over, and install with install.sh --from.',
  'service.remote.step.stop': 'Then stop the service once it’s idle:',
  'service.remote.step.after': 'Reconnect afterwards and Litch starts the new version.',
  'service.remote.confirm.title': 'Upgrade the device service on {name}',
  'service.remote.confirm.swapTitle': 'Switch the device service on {name} to the new version',
  'service.remote.confirm.version': 'Installs {to}. Currently running {from}.',
  'service.remote.confirm.version.unknown': 'Installs {to}.',
  'service.remote.confirm.swapVersion': '{installed} is installed. Currently running {from}.',
  'service.remote.confirm.script':
    'Method: install script, into ~/.local/share/codex-harness-adapter/{to}.',
  'service.remote.confirm.brew': 'Method: Homebrew.',
  'service.remote.confirm.idle':
    'Nothing in progress is interrupted: the new version takes over once the service is idle.',
  'service.remote.confirm.managed':
    'This service runs in the foreground or under a service manager: Litch only installs and doesn’t restart it.',
  'service.remote.confirm.yes': 'Upgrade',
  'service.remote.confirm.swapYes': 'Switch',
  'service.remote.confirm.no': 'Cancel',
  'service.remote.force.title': 'Switch to the new version now?',
  'service.remote.force.note':
    'This stops the device service on {name} right away and interrupts the following:',
  'service.remote.force.clients':
    'Other clients connected to this device are disconnected and reconnect on their own.',
  'service.remote.force.yes': 'Switch Now',
}
