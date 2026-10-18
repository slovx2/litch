// litch_computer 在 Windows 上的那一半（共用的审批、名单、出错的说法在 executor.mts）。助手的协议见 wire.mts。
//
// 和 macOS 不同的地方：
//   - 没有系统权限这一步。
//   - 应用按应用号认（打包应用是 AUMID，其余是 exe 的完整路径，不分大小写），授权也记在应用号上。
//   - 助手只回结构化的界面树（WinNode），编号、差异、文字化在这边（ax-text.mts）。工具参数里的 element 编号换成助手认的
//     ref；drag 的 from_element / to_element 换成元素中心的截图坐标；坐标动作带上最近一次截图的截图号。
//   - 助手的动作只回 {}，这边接着用 getAppState{screenshot:false} 取树算差异，和 macOS 一样附在结果里。
//   - 结果里写窗口号、这个应用的其他窗口（弹出的对话框是另一个窗口）。
//   - 用户按了物理 Esc，助手只发 stopped 通知，“本回合不再操作这个应用”记在这边，回合结束时清掉。
// 编号、截图、停止的记录都按“会话 + 应用”记，回合结束时清掉（和 macOS 助手一样）。

import type { ClientToolCallResponse } from '../../../../packages/protocol/src/client-tools.mjs'
import { clientToolFailure } from '../../../../packages/protocol/src/client-tools.mjs'
import { COMPUTER_TOOL } from '../../../../packages/protocol/src/client-tools-computer.mjs'
import type { ClientToolContext, ClientToolInvocation } from '../client-tools/types.mjs'
import { ACTION_DIFF_LIMIT, AXIndexBook, type AXLine, diff, render } from './ax-text.mjs'
import {
  type Approve,
  CALL_TIMEOUT,
  type HelperAccess,
  sessionKey,
  text,
} from './executor-shared.mjs'
import { classifyApp } from './policy.mjs'
import { exeName } from './policy-win.mjs'
import { type WinShot, winActionParams } from './win-params.mjs'
import {
  isWinHello,
  type WinAppStateResult,
  type WinHelperApp,
  type WinIntegrity,
} from './wire.mjs'

/** 一个会话里一个应用的状态 */
interface AppBook {
  book: AXIndexBook
  /** 最近一次的行，按编号 */
  lines: Map<number, AXLine>
  /** 最近一次截图 */
  shot: WinShot | null
  /** 最近一次取状态的窗口 */
  windowId: number | null
}

const RANK: Record<WinIntegrity, number> = { low: 0, medium: 1, high: 2, system: 3 }

export interface WinRunnerDeps {
  helper: HelperAccess
  approve: Approve
}

export function createWinRunner(deps: WinRunnerDeps) {
  const { helper, approve } = deps
  /** 会话 → 应用号（小写）→ 状态 */
  const books = new Map<string, Map<string, AppBook>>()
  /** 会话 → 用户按了停止的应用号（小写） */
  const halted = new Map<string, Set<string>>()

  function bookOf(session: string, appId: string): AppBook {
    let apps = books.get(session)
    if (!apps) books.set(session, (apps = new Map()))
    const key = appId.toLowerCase()
    let entry = apps.get(key)
    if (!entry) {
      entry = { book: new AXIndexBook(), lines: new Map(), shot: null, windowId: null }
      apps.set(key, entry)
    }
    return entry
  }

  /** 助手现在的完整性级别；不知道按 medium */
  function helperIntegrity(): WinIntegrity {
    const hello = helper.connected?.hello
    return isWinHello(hello) ? hello.integrity : 'medium'
  }

  async function listApps(signal: AbortSignal): Promise<WinHelperApp[]> {
    const client = await helper.client()
    const { apps } = (await client.request('listApps', {}, 10_000, signal)) as {
      apps: WinHelperApp[]
    }
    return apps
  }

  /** 按模型给的应用号、显示名、exe 文件名（带不带 .exe）、AUMID 找应用，都不分大小写 */
  function findApp(apps: WinHelperApp[], query: string): WinHelperApp | null {
    const lower = query.trim().toLowerCase()
    const bare = lower.endsWith('.exe') ? lower : `${lower}.exe`
    return (
      apps.find((one) => one.appId.toLowerCase() === lower) ??
      apps.find((one) => one.name.toLowerCase() === lower) ??
      apps.find((one) => one.aumid?.toLowerCase() === lower) ??
      apps.find((one) => exeName(one.exe) === bare) ??
      null
    )
  }

  function listText(apps: WinHelperApp[]): string {
    if (apps.length === 0) return 'No app has a window on screen.'
    const mine = RANK[helperIntegrity()]
    const lines: string[] = []
    for (const one of apps) {
      const risk = classifyApp({ platform: 'win32', ...one })
      const note =
        risk === 'forbidden'
          ? ' (not allowed)'
          : RANK[one.integrity] > mine
            ? ' (runs as administrator; cannot be controlled)'
            : one.active
              ? ' (frontmost)'
              : ''
      lines.push(`- ${one.name} — ${one.appId}${note}`)
      for (const window of one.windows) {
        const flags = [window.active ? 'active' : '', window.minimized ? 'minimized' : '']
          .filter(Boolean)
          .join(', ')
        lines.push(`    window ${window.id}: ${quote(window.title)}${flags ? ` (${flags})` : ''}`)
      }
    }
    return `Apps with windows:\n${lines.join('\n')}`
  }

  /** 取状态，编号，记下截图；回给模型的文字 */
  async function getState(
    session: string,
    app: WinHelperApp,
    windowId: number | null,
    full: boolean,
    signal: AbortSignal,
  ): Promise<ClientToolCallResponse> {
    const client = await helper.client()
    const state = (await client.request(
      'getAppState',
      { session, appId: app.appId, ...(windowId !== null ? { windowId } : {}), screenshot: true },
      CALL_TIMEOUT,
      signal,
    )) as WinAppStateResult
    const entry = bookOf(session, app.appId)
    // 换了窗口：和别的窗口的树比差异没有意义，给全文
    if (full || entry.windowId !== state.window.id) entry.book.forget()
    const lines = entry.book.lines(state.tree)
    const changes = diff(entry.book.previous, lines)
    remember(entry, lines, state)
    const shot = state.screenshot
    const header = [
      `App: ${state.app.name} (${state.app.appId}), window ${state.window.id} ${quote(state.window.title)}.`,
      ...otherWindows(state),
      shot
        ? `Screenshot: ${shot.width}x${shot.height} pixels; x/y in actions are pixels of this image.`
        : 'No screenshot is available; act by element number.',
      ...state.notes.map((note) => `Note: ${note}`),
      changes !== null
        ? 'Accessibility tree, changes since the previous state (+ added, - removed, ~ changed):'
        : 'Accessibility tree:',
    ].join('\n')
    const note = state.truncated
      ? '\n(The tree was too large and was cut; use the screenshot for what is missing.)'
      : ''
    return {
      success: true,
      contentItems: [
        { type: 'inputText', text: `${header}\n${changes ?? render(lines)}${note}` },
        ...(shot
          ? [{ type: 'inputImage' as const, imageUrl: `data:${shot.mime};base64,${shot.data}` }]
          : []),
      ],
    }
  }

  function remember(entry: AppBook, lines: AXLine[], state: WinAppStateResult): void {
    entry.book.remember(lines)
    entry.lines = new Map(lines.map((line) => [line.index, line]))
    entry.windowId = state.window.id
    if (state.screenshot) {
      const { id, width, height } = state.screenshot
      entry.shot = { id, width, height }
    }
  }

  /** 动作做完：不截图再取一次树，附上差异 */
  async function afterAction(
    session: string,
    app: WinHelperApp,
    windowId: number | null,
    summary: string,
    signal: AbortSignal,
  ): Promise<ClientToolCallResponse> {
    const entry = bookOf(session, app.appId)
    try {
      const client = await helper.client()
      const state = (await client.request(
        'getAppState',
        {
          session,
          appId: app.appId,
          ...(windowId !== null ? { windowId } : {}),
          screenshot: false,
        },
        CALL_TIMEOUT,
        signal,
      )) as WinAppStateResult
      const moved = entry.windowId !== state.window.id
      if (moved) entry.book.forget()
      const lines = entry.book.lines(state.tree)
      const changes = diff(entry.book.previous, lines, ACTION_DIFF_LIMIT)
      remember(entry, lines, state)
      const where = moved
        ? `\n\nThe app's window is now ${state.window.id} ${quote(state.window.title)}; its accessibility tree:\n`
        : "\n\nChanges in the app's accessibility tree since the last state:\n"
      const others = otherWindows(state)
      return text(
        `${summary}${where}${changes ?? render(lines, ACTION_DIFF_LIMIT)}${others.length > 0 ? `\n\n${others.join('\n')}` : ''}`,
      )
    } catch (error) {
      if (signal.aborted) throw error
      return text(
        `${summary}\n\n(Could not read the app's state after the action; call get_app_state.)`,
      )
    }
  }

  async function run(
    invocation: ClientToolInvocation,
    context: ClientToolContext,
  ): Promise<ClientToolCallResponse> {
    const { tool } = invocation
    const params = invocation.arguments as Record<string, unknown>
    const { signal } = context
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return clientToolFailure('invalid', 'Arguments must be a JSON object.')
    }
    if (tool === COMPUTER_TOOL.listApps) return text(listText(await listApps(signal)))
    if (!Object.values(COMPUTER_TOOL).includes(tool as never)) {
      return clientToolFailure('invalid', `Unknown tool ${tool} in litch_computer.`)
    }
    if (typeof params.app !== 'string' || params.app.trim() === '') {
      return clientToolFailure(
        'invalid',
        'app is required: an app id from list_apps or an app name.',
      )
    }
    const window = params.window
    if (window !== undefined && (!Number.isInteger(window) || (window as number) < 0)) {
      return clientToolFailure('invalid', 'window must be a window number from list_apps.')
    }

    const app = findApp(await listApps(signal), params.app)
    if (!app) {
      return clientToolFailure(
        'failed',
        `No app with a window matches "${params.app}". Call list_apps; if the app is not running, ask the user to open it.`,
      )
    }
    const session = sessionKey(invocation)
    const risk = classifyApp({ platform: 'win32', ...app })
    // 管理员窗口发不进输入，问用户也没用：先说清楚（禁止的照审批那边的说法）
    if (risk !== 'forbidden' && RANK[app.integrity] > RANK[helperIntegrity()]) {
      return clientToolFailure(
        'failed',
        `${app.name} runs as administrator, so Litch cannot control it. Ask the user to do this step themselves.`,
      )
    }
    if (halted.get(session)?.has(app.appId.toLowerCase())) {
      return clientToolFailure(
        'failed',
        `The user stopped you from controlling ${app.name} for the rest of this turn. Do not try again in this turn; summarize what you did and what is left.`,
      )
    }
    const refused = await approve(invocation, context, { key: app.appId, name: app.name, risk })
    if (refused) return refused

    const entry = bookOf(session, app.appId)
    const windowId = typeof window === 'number' ? window : entry.windowId
    if (tool === COMPUTER_TOOL.getAppState) {
      return getState(session, app, windowId, params.full === true, signal)
    }
    const action = winActionParams(tool, params, entry)
    const client = await helper.client()
    await client.request(
      action.method,
      {
        session,
        appId: app.appId,
        ...(windowId !== null ? { windowId } : {}),
        ...action.params,
      },
      CALL_TIMEOUT,
      signal,
    )
    return afterAction(session, app, windowId, action.summary, signal)
  }

  return {
    run,
    turnEnded(session: string): void {
      books.delete(session)
      halted.delete(session)
    },
    stopped(session: string, appId: string): void {
      let set = halted.get(session)
      if (!set) halted.set(session, (set = new Set()))
      set.add(appId.toLowerCase())
    },
  }
}

function otherWindows(state: WinAppStateResult): string[] {
  const others = state.windows.filter((one) => one.id !== state.window.id)
  if (others.length === 0) return []
  return [
    `Other windows of this app: ${others.map((one) => `${one.id} ${quote(one.title)}`).join('; ')}.`,
  ]
}

function quote(title: string | null | undefined): string {
  return JSON.stringify(title ?? '')
}
