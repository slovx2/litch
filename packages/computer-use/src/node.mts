// 显式选择 Node 启动器时才创建本机连接；模块导入没有启动副作用。
import { type ComputerUseOptions, createComputerUse } from './index.mjs'
import { MacLauncher, type MacLauncherOptions } from './launcher-mac.mjs'
import { WinLauncher, type WinLauncherOptions } from './launcher-win.mjs'
import { type HelperLauncher, HelperSupervisor } from './supervisor.mjs'
import type { HelperStopped } from './wire.mjs'

export { childChannel, type HelperChannel, HelperClient, socketChannel } from './helper-client.mjs'
export { MacLauncher, type MacLauncherOptions } from './launcher-mac.mjs'
export { WinLauncher, type WinLauncherOptions } from './launcher-win.mjs'
export { type HelperLauncher, HelperSupervisor } from './supervisor.mjs'
export { encodeFrame, FrameReader, HelperError } from './wire.mjs'
export type NodeComputerUseOptions = Omit<ComputerUseOptions, 'helper' | 'disposeHelper'> & {
  lang: string
  launcher: HelperLauncher
  log?(line: string): void
  onAutomation?(notice: unknown): void
  onDisconnected?(): void
  onStopped?(notice: HelperStopped): void
}
export function createNodeComputerUse(options: NodeComputerUseOptions) {
  let lang = options.lang
  const supervisor = new HelperSupervisor({
    launcher: options.launcher,
    lang: () => lang,
    ...(options.log ? { log: options.log } : {}),
    ...(options.onAutomation ? { onAutomation: options.onAutomation } : {}),
    ...(options.onDisconnected ? { onDisconnected: options.onDisconnected } : {}),
    onStopped: (notice) => {
      runtime.stopped(notice)
      options.onStopped?.(notice)
    },
  })
  const runtime = createComputerUse({
    ...options,
    helper: supervisor,
    disposeHelper: () => supervisor.dispose(),
  })
  return {
    ...runtime,
    supervisor,
    setLanguage(next: string) {
      lang = next
      supervisor.setLanguage(next)
    },
  }
}

/** 资源和运行目录都必须由宿主选择，绝不推导别的应用路径。 */
export function createNativeLauncher(
  options:
    | { platform: 'darwin'; options: MacLauncherOptions }
    | { platform: 'win32'; options: WinLauncherOptions },
): HelperLauncher {
  return options.platform === 'darwin'
    ? new MacLauncher(options.options)
    : new WinLauncher(options.options)
}
