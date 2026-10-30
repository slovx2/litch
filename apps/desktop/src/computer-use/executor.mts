// litch_computer 的执行器：模型的每次调用在这里过一遍检查，再交给助手执行。
// 所有应用都能操作，不按应用审批，本机和远程设备的会话一样；
// 能不能用只看设备和 harness 两级的开关（核心在调用到这里之前查）。
// 出错的说法两个平台共用；Windows 上找应用、编号、换算坐标、组装结果在 executor-win.mts（platform 为 win32 时）。
//
// macOS 上一次调用的顺序：
//   1. 认工具、看参数是不是对象
//   2. list_apps 不要系统权限，直接问助手；别的先查辅助功能和屏幕录制，缺了回 permission，告诉模型和用户去哪里开
//   3. 应用名由助手解析一次，避免主进程重复枚举窗口
//   4. 交给助手，结果转成给模型的文字和截图
// 回合结束时告诉助手：撤掉屏幕提示、清掉这个会话的编号和“已停止”的记录。
import {
  CLIENT_TOOL_NAMESPACE,
  type ClientToolCallResponse,
  type ClientToolContentItem,
  clientToolFailure,
} from '../../../../packages/protocol/src/client-tools.mjs'
import { COMPUTER_TOOL } from '../../../../packages/protocol/src/client-tools-computer.mjs'
import type {
  ClientToolContext,
  ClientToolExecutor,
  ClientToolInvocation,
} from '../client-tools/types.mjs'
import { CALL_TIMEOUT, type HelperAccess, sessionKey, text } from './executor-shared.mjs'
import { createWinRunner } from './executor-win.mjs'
import {
  type ActionResult,
  type AppMenuStateResult,
  type AppStateResult,
  type HelperApp,
  HelperError,
  type HelperStopped,
  type PermissionStatus,
} from './wire.mjs'

export type { HelperAccess, HelperRequester } from './executor-shared.mjs'
export { sessionKey } from './executor-shared.mjs'

export interface ComputerExecutorOptions {
  onInvocation?(invocation: ClientToolInvocation, session: string): void
  helper: HelperAccess
  /** 这台桌面的平台：win32 走 Windows 那一套，别的按 macOS */
  platform?: string
  /** 测试用的时钟 */
  now?(): number
}

/** 工具名 → 助手的方法 */
const ACTIONS: Record<string, string> = {
  [COMPUTER_TOOL.click]: 'click',
  [COMPUTER_TOOL.typeText]: 'typeText',
  [COMPUTER_TOOL.pressKey]: 'pressKey',
  [COMPUTER_TOOL.scroll]: 'scroll',
  [COMPUTER_TOOL.setValue]: 'setValue',
  [COMPUTER_TOOL.drag]: 'drag',
  [COMPUTER_TOOL.selectText]: 'selectText',
}

/** litch_computer 的执行器，外加助手发来的“用户按了停止”从这里进 */
export interface ComputerExecutor extends ClientToolExecutor {
  stopped(notice: HelperStopped): void
}

/** 没给权限时给模型（和用户）看的话 */
export function permissionMessage(status: PermissionStatus): string {
  const missing = [
    status.accessibility ? null : 'Accessibility',
    status.screenRecording ? null : 'Screen Recording',
  ].filter(Boolean)
  return (
    `Litch Computer Use does not have macOS permission for ${missing.join(' and ')}. ` +
    'Tell the user to open System Settings > Privacy & Security, turn on "Litch Computer Use" under ' +
    `${missing.join(' and under ')}, then ask you to try again. Do not try other ways to control the app.`
  )
}

export function createComputerExecutor(options: ComputerExecutorOptions): ComputerExecutor {
  const { helper } = options
  const platform = options.platform === 'win32' ? 'win32' : 'darwin'
  const now = options.now ?? Date.now
  let lastRestart = 0

  /** 查权限；缺了先重启一次助手再查（授权之后旧进程看不到新权限），30 秒内不重复重启 */
  async function permissions(signal: AbortSignal): Promise<PermissionStatus> {
    const client = await helper.client()
    let status = (await client.request('permissions', {}, 5000, signal)) as PermissionStatus
    if ((!status.accessibility || !status.screenRecording) && now() - lastRestart > 30_000) {
      lastRestart = now()
      await helper.restart()
      const fresh = await helper.client()
      status = (await fresh.request('permissions', {}, 5000, signal)) as PermissionStatus
    }
    return status
  }

  async function run(
    invocation: ClientToolInvocation,
    context: ClientToolContext,
  ): Promise<ClientToolCallResponse> {
    const tool = invocation.tool
    const args = invocation.arguments
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return clientToolFailure('invalid', 'Arguments must be a JSON object.')
    }
    const params = args as Record<string, unknown>
    const { signal } = context

    if (tool === COMPUTER_TOOL.listApps) {
      const client = await helper.client()
      const { apps } = (await client.request('listApps', {}, 10_000, signal)) as {
        apps: HelperApp[]
      }
      const lines = apps.map((one) => {
        const note =
          (one.active ? ' (frontmost)' : '') + (one.windows === 0 ? ' (no visible windows)' : '')
        const also = one.fileName && one.fileName !== one.name ? ` (${one.fileName})` : ''
        return `- ${one.name}${also} — ${one.bundleId ?? 'no bundle id'}${note}`
      })
      return text(
        lines.length > 0 ? `Running apps:\n${lines.join('\n')}` : 'No regular app is running.',
      )
    }

    const method = tool === COMPUTER_TOOL.getAppState ? 'getAppState' : ACTIONS[tool]
    if (!method)
      return clientToolFailure(
        'invalid',
        `Unknown tool ${tool} in ${CLIENT_TOOL_NAMESPACE.computer}.`,
      )
    if (typeof params.app !== 'string' || params.app.trim() === '') {
      return clientToolFailure(
        'invalid',
        'app is required: a bundle identifier from list_apps or an app name.',
      )
    }

    const status = await permissions(signal)
    if (!status.accessibility || !status.screenRecording) {
      return clientToolFailure('permission', permissionMessage(status))
    }

    const client = await helper.client()
    const session = sessionKey(invocation)
    options.onInvocation?.(invocation, session)
    const request = {
      ...params,
      app: params.app.trim(),
      session,
      turnId: invocation.turnId,
      actionId: invocation.id,
    }
    const result = await client.request(method, request, CALL_TIMEOUT, signal)
    if (method === 'getAppState')
      return stateResponse(result as AppStateResult | AppMenuStateResult)
    return text((result as ActionResult).text)
  }

  const win = platform === 'win32' ? createWinRunner({ helper }) : null

  return {
    namespace: CLIENT_TOOL_NAMESPACE.computer,
    async call(invocation, context) {
      try {
        return await (win ? win.run(invocation, context) : run(invocation, context))
      } catch (error) {
        return failureOf(error, context.signal)
      }
    },
    turnEnded(turn) {
      const session = sessionKey({ device: { id: turn.deviceId }, threadId: turn.threadId })
      win?.turnEnded(session)
      helper.connected?.request('turnEnded', { session, turnId: turn.turnId }, 5000).catch(() => {})
    },
    // macOS 的“已停止”记在助手里（它自己拒）；Windows 助手只发通知，记在这边
    stopped(notice) {
      if ('appId' in notice) win?.stopped(notice.session, notice.appId)
    },
  }
}

function stateResponse(state: AppStateResult | AppMenuStateResult): ClientToolCallResponse {
  if ('windowless' in state) {
    return text(
      `App: ${state.app.name} (${state.app.bundleId}). No uniquely identified window is available for a screenshot.\n` +
        `Visible windows: ${state.visibleWindows}; accessible window: ${state.accessibleWindow ?? 'none'}; foreground app: ${state.frontmost ?? 'none'}.\n` +
        `Menu bar: ${state.menuAvailable ? 'available below' : 'not exposed by this app'}. ` +
        'You can use press_key (for example cmd+n to create a document) or an available menu element. If an Open panel is blocking creation, use Escape or its Cancel button, then cmd+n. Screenshot coordinates are unavailable.\n' +
        `${state.diff ? 'Accessibility changes' : 'Accessibility tree'}:\n${state.text}`,
    )
  }
  const title = state.window.title ? ` "${state.window.title}"` : ''
  const header =
    `App: ${state.app.name} (${state.app.bundleId ?? 'no bundle id'}), window${title}.\n` +
    (state.window.id === undefined
      ? ''
      : `Window ID: ${state.window.id}; tree observed at ${state.window.observedAt}, screenshot captured at ${state.window.capturedAt} (Unix ms). These are sequential observations, not an atomic snapshot.\n`) +
    `Screenshot: ${state.screenshot.width}x${state.screenshot.height} pixels; x/y in actions are pixels of this image.\n` +
    (state.diff
      ? 'Accessibility tree, changes since the previous state (+ added, - removed, ~ changed):'
      : 'Accessibility tree:')
  const note = state.truncated
    ? '\n(The tree was too large and was cut; use the screenshot for what is missing.)'
    : ''
  const items: ClientToolContentItem[] = [
    { type: 'inputText', text: `${header}\n${state.text}${note}` },
    {
      type: 'inputImage',
      imageUrl: `data:${state.screenshot.mime};base64,${state.screenshot.data}`,
    },
  ]
  return { success: true, contentItems: items }
}

/** 出错转成失败答复。助手给的说明本来就是写给模型的，照转；Windows 的三种再补一句该怎么办 */
function failureOf(error: unknown, signal: AbortSignal): ClientToolCallResponse {
  if (signal.aborted) return clientToolFailure('failed', 'The call was cancelled.')
  if (error instanceof HelperError) {
    switch (error.kind) {
      case 'permission':
        return clientToolFailure(
          'permission',
          permissionMessage({
            accessibility: !error.message.includes('Accessibility'),
            screenRecording: !error.message.includes('Screen Recording'),
          }),
        )
      case 'invalid':
        return clientToolFailure('invalid', error.message)
      case 'elevated':
        return clientToolFailure(
          'failed',
          `${error.message} Litch cannot control windows that run as administrator. Ask the user to do this step themselves.`,
        )
      case 'locked':
        return clientToolFailure(
          'failed',
          `${error.message} The computer is locked or showing a secure prompt. Stop and ask the user to unlock it, then try again.`,
        )
      case 'foreground':
        return clientToolFailure(
          'failed',
          `${error.message} Ask the user to click the app's window once, then try again.`,
        )
      default:
        return clientToolFailure('failed', error.message)
    }
  }
  return clientToolFailure(
    'failed',
    `Litch Computer Use is not available: ${(error as Error)?.message ?? String(error)}`,
  )
}
