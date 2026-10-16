// Computer Use 在主进程这一侧的入口：主进程启动时（只在 macOS 上）调 createComputerUse，把返回的 executor 登记到
// 客户端工具的登记表里，界面语言变了调 setLanguage，退出前调 dispose。设置页要的“始终允许”清单的读、删，权限状态和
// 打开系统设置对应的那一页，也在返回的对象上。
//
// 这里不引 electron：要的几样（是否打包、资源目录、用户数据目录、版本、语言）由调用方传进来，方便测试。
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AlwaysAllowedApp, ApprovalStore } from './approvals.mjs'
import { createComputerExecutor } from './executor.mjs'
import { HelperSupervisor } from './supervisor.mjs'
import type { PermissionStatus, StoppedNotice } from './wire.mjs'

/** 助手应用的名字 */
export const HELPER_APP_NAME = 'Litch Computer Use.app'

export interface ComputerUseOptions {
  /** 桌面端的用户数据目录（app.getPath('userData')） */
  userData: string
  /** 助手应用的路径，用 locateHelperApp 算 */
  appPath: string
  /** Litch 的版本：在跑的助手版本不一样就换掉（开发时可以给 null 不比） */
  version: string | null
  /** 界面语言（zh-CN、en） */
  lang: string
  log?(line: string): void
  /** 用户在屏幕提示上按了停止 */
  onStopped?(notice: StoppedNotice): void
}

/**
 * 助手在哪：设了 LITCH_COMPUTER_USE_APP 用它；打包后在 Litch.app/Contents/SharedSupport 里
 * （resourcesPath 是 Contents/Resources）；开发时用 apps/computer-use/build-app.mjs 组装出来的那一份
 */
export function locateHelperApp(where: {
  packaged: boolean
  resourcesPath: string
  env?: NodeJS.ProcessEnv
}): string {
  const override = (where.env ?? process.env).LITCH_COMPUTER_USE_APP
  if (override) return override
  if (where.packaged) return join(where.resourcesPath, '..', 'SharedSupport', HELPER_APP_NAME)
  // 主进程打包成 apps/desktop/dist/main.mjs，开发时的助手在 apps/computer-use/out/ 下
  return fileURLToPath(new URL(`../../computer-use/out/${HELPER_APP_NAME}`, import.meta.url))
}

export function createComputerUse(options: ComputerUseOptions) {
  let lang = options.lang
  const store = new ApprovalStore(options.userData)
  const supervisor = new HelperSupervisor({
    appPath: options.appPath,
    directory: join(options.userData, 'computer-use'),
    version: options.version,
    lang: () => lang,
    ...(options.log ? { log: options.log } : {}),
    onStopped: (notice) => {
      options.log?.(`[computer-use] 用户停止了 ${notice.app}（会话 ${notice.session}）`)
      options.onStopped?.(notice)
    },
  })
  const executor = createComputerExecutor({ helper: supervisor, store })

  return {
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
    removeAlwaysAllowed(bundleId: string): boolean {
      return store.remove(bundleId)
    },
    /** 设置页：两项系统权限现在给了没有（会拉起助手） */
    async permissions(): Promise<PermissionStatus> {
      const client = await supervisor.client()
      return (await client.request('permissions', {}, 5000)) as PermissionStatus
    },
    /** 设置页：打开系统设置里对应的那一页，让用户自己去打开开关（不替用户改） */
    async openPermissionSettings(pane: 'accessibility' | 'screenRecording'): Promise<boolean> {
      const client = await supervisor.client()
      const { opened } = (await client.request('openSettings', { pane }, 5000)) as {
        opened: boolean
      }
      return opened
    },
    /** 用户授权了屏幕录制之后：重启助手让新权限生效 */
    restartHelper(): Promise<void> {
      return supervisor.restart()
    },
    dispose(): Promise<void> {
      return supervisor.dispose()
    },
  }
}

export type ComputerUse = ReturnType<typeof createComputerUse>
