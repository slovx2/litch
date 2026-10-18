// Computer Use 在主进程这一侧的入口：主进程启动时（macOS 和 Windows 上）调 createComputerUse，把返回的 executor 登记到
// 客户端工具的登记表里，界面语言变了调 setLanguage，退出前调 dispose。设置页要的“始终允许”清单的读、删，助手的状态，
// macOS 的权限状态和打开系统设置对应的那一页，也在返回的对象上。
//
// 两个平台的助手不同：macOS 是单独签名的应用（launcher-mac.mts），Windows 是 Litch 子进程起的 exe（launcher-win.mts）。
// 这里不引 electron：要的几样（平台、是否打包、资源目录、用户数据目录、版本、语言）由调用方传进来，方便测试。
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AlwaysAllowedApp, ApprovalStore } from './approvals.mjs'
import { createComputerExecutor } from './executor.mjs'
import { MacLauncher } from './launcher-mac.mjs'
import { WinLauncher, type WinLauncherOptions } from './launcher-win.mjs'
import { type HelperLauncher, HelperSupervisor } from './supervisor.mjs'
import {
  type HelperStopped,
  isWinHello,
  type PermissionStatus,
  type WinIntegrity,
} from './wire.mjs'

/** 助手应用的名字（macOS） */
export const HELPER_APP_NAME = 'Litch Computer Use.app'
/** 助手的可执行文件名（Windows，09 号 9.3） */
export const HELPER_EXE_NAME = 'litch-computer-use.exe'

export interface ComputerUseOptions {
  /** 这台桌面的平台（process.platform）：darwin、win32 */
  platform: string
  /** 桌面端的用户数据目录（app.getPath('userData')） */
  userData: string
  /** 助手的路径，用 locateHelper 算（macOS 是应用，Windows 是 exe） */
  helperPath: string
  /** Litch 的版本：在跑的助手版本不一样就换掉（开发时可以给 null 不比） */
  version: string | null
  /** 界面语言（zh-CN、en） */
  lang: string
  log?(line: string): void
  /** 用户在屏幕提示上按了停止（macOS）或按了物理 Esc（Windows） */
  onStopped?(notice: HelperStopped): void
  /** 测试用：Windows 上怎么起助手（在 macOS 上用 node 跑假助手） */
  spawnWin?: WinLauncherOptions['spawn']
}

/** Windows 设置页要的助手信息（握手时报的） */
export interface WinHelperInfo {
  pid: number
  version: string | null
  integrity: WinIntegrity
  uacEnabled: boolean
}

/**
 * 助手在哪。
 * macOS：设了 LITCH_COMPUTER_USE_APP 用它；打包后在 Litch.app/Contents/SharedSupport 里（resourcesPath 是
 * Contents/Resources）；开发时用 apps/computer-use/build-app.mjs 组装出来的那一份。
 * Windows：设了 LITCH_COMPUTER_USE_WIN_HELPER 用它；打包后在 <resources>/computer-use/ 下；开发时是
 * apps/computer-use-win 交叉编译出来的那一份（构建命令见 09 号 9.3）。
 */
export function locateHelper(where: {
  platform: string
  packaged: boolean
  resourcesPath: string
  env?: NodeJS.ProcessEnv
}): string {
  const env = where.env ?? process.env
  if (where.platform === 'win32') {
    if (env.LITCH_COMPUTER_USE_WIN_HELPER) return env.LITCH_COMPUTER_USE_WIN_HELPER
    if (where.packaged) return join(where.resourcesPath, 'computer-use', HELPER_EXE_NAME)
    // 主进程打包成 apps/desktop/dist/main.mjs
    return fileURLToPath(
      new URL(
        `../../computer-use-win/target/x86_64-pc-windows-msvc/release/${HELPER_EXE_NAME}`,
        import.meta.url,
      ),
    )
  }
  if (env.LITCH_COMPUTER_USE_APP) return env.LITCH_COMPUTER_USE_APP
  if (where.packaged) return join(where.resourcesPath, '..', 'SharedSupport', HELPER_APP_NAME)
  // 主进程打包成 apps/desktop/dist/main.mjs，开发时的助手在 apps/computer-use/out/ 下
  return fileURLToPath(new URL(`../../computer-use/out/${HELPER_APP_NAME}`, import.meta.url))
}

export function createComputerUse(options: ComputerUseOptions) {
  let lang = options.lang
  const windows = options.platform === 'win32'
  const store = new ApprovalStore(options.userData)
  const launcher: HelperLauncher = windows
    ? new WinLauncher({
        exePath: options.helperPath,
        version: options.version,
        ...(options.spawnWin ? { spawn: options.spawnWin } : {}),
      })
    : new MacLauncher({
        appPath: options.helperPath,
        directory: join(options.userData, 'computer-use'),
        version: options.version,
      })
  const supervisor = new HelperSupervisor({
    launcher,
    lang: () => lang,
    ...(options.log ? { log: options.log } : {}),
    onStopped: (notice) => {
      const app = 'appId' in notice ? notice.appId : notice.app
      options.log?.(`[computer-use] 用户停止了 ${app}（会话 ${notice.session}）`)
      executor.stopped(notice)
      options.onStopped?.(notice)
    },
  })
  const executor = createComputerExecutor({ helper: supervisor, store, platform: options.platform })

  return {
    platform: windows ? ('win32' as const) : ('darwin' as const),
    executor,
    supervisor,
    setLanguage(next: string): void {
      lang = next
      supervisor.setLanguage(next)
    },
    /** 设置页：“始终允许”的应用 */
    listAlwaysAllowed(): AlwaysAllowedApp[] {
      return store.list()
    },
    /** 设置页：从“始终允许”里删掉一个 */
    removeAlwaysAllowed(appKey: string): boolean {
      return store.remove(appKey)
    },
    /** 设置页（macOS）：两项系统权限现在给了没有（会拉起助手）。Windows 上没有这回事 */
    async permissions(): Promise<PermissionStatus> {
      if (windows) return { accessibility: true, screenRecording: true }
      const client = await supervisor.client()
      return (await client.request('permissions', {}, 5000)) as PermissionStatus
    },
    /** 设置页（Windows）：助手的状态。launch 为真时没在跑就拉起它 */
    async helperInfo(launch: boolean): Promise<WinHelperInfo | null> {
      const client = launch ? await supervisor.client() : supervisor.connected
      const hello = client?.hello
      if (!isWinHello(hello)) return null
      return {
        pid: hello.pid,
        version: hello.version,
        integrity: hello.integrity,
        uacEnabled: hello.uacEnabled,
      }
    },
    /** 设置页（macOS）：打开系统设置里对应的那一页，让用户自己去打开开关（不替用户改） */
    async openPermissionSettings(pane: 'accessibility' | 'screenRecording'): Promise<boolean> {
      if (windows) return false
      const client = await supervisor.client()
      const { opened } = (await client.request('openSettings', { pane }, 5000)) as {
        opened: boolean
      }
      return opened
    },
    /** 重启助手（macOS 授权了屏幕录制之后让新权限生效；设置页的“重启助手”） */
    restartHelper(): Promise<void> {
      return supervisor.restart()
    },
    dispose(): Promise<void> {
      return supervisor.dispose()
    },
  }
}

export type ComputerUse = ReturnType<typeof createComputerUse>
