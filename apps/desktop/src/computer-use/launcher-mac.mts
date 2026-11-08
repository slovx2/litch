// Litch 的身份与环境键由宿主提供，通用启动器不查找产品路径。
import {
  MacLauncher as SharedLauncher,
  type MacLauncherOptions as SharedOptions,
} from '../../../../third_party/litch-automation/packages/computer-use/src/launcher-mac.mjs'

export { openApp } from '../../../../third_party/litch-automation/packages/computer-use/src/launcher-mac.mjs'
export type MacLauncherOptions = Omit<SharedOptions, 'identity'>
export class MacLauncher extends SharedLauncher {
  constructor(options: MacLauncherOptions) {
    super({
      ...options,
      identity: {
        helperId: 'io.github.slovx2.litch.computer-use',
        helperName: 'Litch Computer Use',
        executableName: 'LitchComputerUse',
        directoryEnv: 'LITCH_COMPUTER_USE_DIR',
        tokenEnv: 'LITCH_COMPUTER_USE_TOKEN',
      },
    })
  }
}
