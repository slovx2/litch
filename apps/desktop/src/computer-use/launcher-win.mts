import {
  WinLauncher as SharedLauncher,
  type WinLauncherOptions as SharedOptions,
} from '../../../../third_party/litch-automation/packages/computer-use/src/launcher-win.mjs'
export type WinLauncherOptions = Omit<SharedOptions, 'productName'>
export class WinLauncher extends SharedLauncher {
  constructor(options: WinLauncherOptions) {
    super({ ...options, productName: 'Litch' })
  }
}
