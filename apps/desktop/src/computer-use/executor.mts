// litch_computer 的执行器：模型的每次调用在这里过一遍检查，再交给助手执行。
//
// 一次调用的顺序：
//   1. 认工具、看参数是不是对象
//   2. list_apps 不要系统权限，直接问助手；别的先查辅助功能和屏幕录制，缺了回 permission，告诉模型和用户去哪里开
//   3. 按模型给的 app 在在跑的应用里找到它，定下包标识（之后只用包标识，模型换个别名绕不过审批）
//   4. 禁止的应用当场回 declined；这个会话没批过这个应用就出卡片问用户（远程设备的会话没有“始终允许”）
//   5. 交给助手，结果转成给模型的文字和截图
// 回合结束时告诉助手：撤掉屏幕提示、清掉这个会话的编号和“已停止”的记录。本会话的授权不随回合清。
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
import type { ApprovalStore } from './approvals.mjs'
import { classifyApp } from './policy.mjs'
import {
  type ActionResult,
  type AppStateResult,
  type HelperApp,
  HelperError,
  type PermissionStatus,
} from './wire.mjs'

/** 执行器要的助手能力（看护者实现它；测试里用桩） */
export interface HelperAccess {
  client(): Promise<HelperRequester>
  /** 重启助手（屏幕录制授权后要重启进程才生效） */
  restart(): Promise<void>
  readonly connected: HelperRequester | null
}

export interface HelperRequester {
  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown>
}

export interface ComputerExecutorOptions {
  helper: HelperAccess
  store: ApprovalStore
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

/** 动作和取状态最多等多久 */
const CALL_TIMEOUT = 60_000

export function sessionKey(invocation: { device: { id: string }; threadId: string }): string {
  return `${invocation.device.id}/${invocation.threadId}`
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

export function createComputerExecutor(options: ComputerExecutorOptions): ClientToolExecutor {
  const { helper, store } = options
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

  /** 按模型给的名字或包标识找应用（和助手的找法一样：包标识、名字、不分大小写的包标识） */
  async function findApp(query: string, signal: AbortSignal): Promise<HelperApp | null> {
    const client = await helper.client()
    const { apps } = (await client.request('listApps', {}, 10_000, signal)) as { apps: HelperApp[] }
    const needle = query.trim()
    const lower = needle.toLowerCase()
    return (
      apps.find((one) => one.bundleId === needle) ??
      apps.find((one) => one.name.toLowerCase() === lower) ??
      apps.find((one) => one.bundleId?.toLowerCase() === lower) ??
      null
    )
  }

  /** 这个会话能不能操作这个应用；不能时回失败答复 */
  async function approve(
    invocation: ClientToolInvocation,
    context: ClientToolContext,
    app: HelperApp & { bundleId: string },
  ): Promise<ClientToolCallResponse | null> {
    const risk = classifyApp(app)
    if (risk === 'forbidden') {
      return clientToolFailure(
        'declined',
        `${app.name} cannot be controlled with Computer Use (password managers, Keychain, system security prompts, System Settings and Litch itself are off limits). Ask the user to do this step themselves.`,
      )
    }
    const session = sessionKey(invocation)
    const remote = invocation.device.kind === 'ssh'
    if (store.isAllowedForSession(session, app.bundleId)) return null
    if (!remote && store.isAlwaysAllowed(app.bundleId)) {
      store.allowForSession(session, app.bundleId)
      return null
    }
    const answer = await context.ask({
      kind: 'app',
      app: { name: app.name, bundleId: app.bundleId },
      risk,
      allowAlways: !remote,
    })
    switch (answer) {
      case 'once':
        return null
      case 'session':
        store.allowForSession(session, app.bundleId)
        return null
      case 'always':
        if (!remote) store.addAlways({ bundleId: app.bundleId, name: app.name })
        store.allowForSession(session, app.bundleId)
        return null
      case 'decline':
        return clientToolFailure(
          'declined',
          `The user did not allow controlling ${app.name}. Do not try to use it again unless the user asks.`,
        )
      default:
        return clientToolFailure(
          'failed',
          'The approval request was cancelled before the user answered.',
        )
    }
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
        const risk = classifyApp(one)
        const note = risk === 'forbidden' ? ' (not allowed)' : one.active ? ' (frontmost)' : ''
        return `- ${one.name} — ${one.bundleId ?? 'no bundle id'}${note}`
      })
      return text(
        lines.length > 0
          ? `Running apps with windows:\n${lines.join('\n')}`
          : 'No app has a window on screen.',
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

    const found = await findApp(params.app, signal)
    if (!found) {
      return clientToolFailure(
        'failed',
        `No running app with a window matches "${params.app}". Call list_apps; if the app is not running, ask the user to open it.`,
      )
    }
    if (!found.bundleId) {
      return clientToolFailure(
        'failed',
        `${found.name} has no bundle identifier and cannot be controlled.`,
      )
    }
    const app = { ...found, bundleId: found.bundleId }
    const refused = await approve(invocation, context, app)
    if (refused) return refused

    const client = await helper.client()
    const request = { ...params, app: app.bundleId, session: sessionKey(invocation) }
    const result = await client.request(method, request, CALL_TIMEOUT, signal)
    if (method === 'getAppState') return stateResponse(result as AppStateResult)
    return text((result as ActionResult).text)
  }

  return {
    namespace: CLIENT_TOOL_NAMESPACE.computer,
    async call(invocation, context) {
      try {
        return await run(invocation, context)
      } catch (error) {
        return failureOf(error, context.signal)
      }
    },
    turnEnded(turn) {
      const session = sessionKey({ device: { id: turn.deviceId }, threadId: turn.threadId })
      helper.connected?.request('turnEnded', { session }, 5000).catch(() => {})
    },
  }
}

function text(value: string): ClientToolCallResponse {
  return { success: true, contentItems: [{ type: 'inputText', text: value }] }
}

function stateResponse(state: AppStateResult): ClientToolCallResponse {
  const title = state.window.title ? ` "${state.window.title}"` : ''
  const header =
    `App: ${state.app.name} (${state.app.bundleId ?? 'no bundle id'}), window${title}.\n` +
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

/** 出错转成失败答复。助手给的说明本来就是写给模型的，照转 */
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
      case 'forbidden':
        return clientToolFailure(
          'declined',
          `${error.message} Ask the user to do this step themselves.`,
        )
      case 'invalid':
        return clientToolFailure('invalid', error.message)
      default:
        return clientToolFailure('failed', error.message)
    }
  }
  return clientToolFailure(
    'failed',
    `Litch Computer Use is not available: ${(error as Error)?.message ?? String(error)}`,
  )
}
