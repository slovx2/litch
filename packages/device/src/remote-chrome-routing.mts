// 路由句柄仅由会话设备签发。拒绝、输入失败和断线都不能触发另一个执行端。
import { randomUUID } from 'node:crypto'
import {
  type ClientToolCallParams,
  type ClientToolCallResponse,
  clientToolFailure,
} from '../../protocol/src/client-tools.mjs'
import type { ChromeAsk, ChromeScope, DeviceChromeRuntime } from './remote-chrome-runtime.mjs'
import { isObject } from './wire.mjs'

type Location = 'controller' | 'sessionDevice'
export interface ChromeController {
  id: string
  hostLabel: string
  ready(): boolean
  call(params: ClientToolCallParams, signal: AbortSignal): Promise<ClientToolCallResponse>
}

interface Route {
  scope: string
  kind: 'targetId' | 'tabId' | 'claimToken'
  location: Location
  controller: ChromeController | null
  /** 底层的实例号、连接代次和真实句柄仅在设备进程内存中使用。 */
  target: string
  epoch: string
  raw: string
  expires: number
}

interface BatchObservation {
  tabId: string
  handle: string
  route: Route
}

interface Context {
  negotiated: boolean
  controller: ChromeController | null
  signal: AbortSignal
  ask: Parameters<DeviceChromeRuntime['call']>[4]
  fullAccess(): Promise<boolean>
}

const prefix = 'chrome:litch-'
const routeFields = ['targetId', 'tabId', 'claimToken'] as const
const maxHandles = 8192
const keyOf = (scope: ChromeScope): string =>
  JSON.stringify([scope.harness, scope.threadId, scope.turnId])
const sameEnd = (a: Route, b: Route): boolean =>
  a.location === b.location && a.controller?.id === b.controller?.id
const sameInstance = (a: Route, b: Route): boolean =>
  sameEnd(a, b) && a.target === b.target && a.epoch === b.epoch
const fail = (message: string) => clientToolFailure('invalid', message)

function hasChrome(args: unknown, opaqueOnly = false): boolean {
  if (!isObject(args)) return false
  if (
    Array.isArray(args.actions) &&
    args.actions.some((step) => isObject(step) && hasChrome(step.arguments, opaqueOnly))
  )
    return true
  return routeFields.some(
    (field) =>
      typeof args[field] === 'string' &&
      (opaqueOnly
        ? args[field].startsWith(prefix)
        : field === 'claimToken'
          ? !args[field].startsWith('builtin:')
          : field !== 'tabId' || args[field].startsWith('chrome:')),
  )
}

export class RemoteChromeRouter {
  private readonly runtime: DeviceChromeRuntime
  private handles = new Map<string, Route>()
  private turns = new Map<string, ChromeController | null>()
  private ended = new Set<string>()

  constructor(runtime: DeviceChromeRuntime) {
    this.runtime = runtime
  }

  route(
    scope: ChromeScope,
    params: ClientToolCallParams,
    context: Context,
  ): Promise<ClientToolCallResponse> | null {
    if (params.namespace !== 'litch_browser') return null
    const key = keyOf(scope)
    const opaque = hasChrome(params.arguments, true)
    if (!opaque && params.tool !== 'targets' && !hasChrome(params.arguments)) return null
    if (!this.turns.has(key) && !(this.runtime.status.enabled && context.negotiated))
      return opaque
        ? Promise.resolve(
            fail('This Chrome handle is no longer available. List targets and claim again.'),
          )
        : null
    if (this.ended.has(JSON.stringify([scope.harness, scope.turnId])))
      return Promise.resolve(fail('This Chrome turn has ended.'))
    if (!this.turns.has(key)) {
      if (this.turns.size >= 1024)
        return Promise.resolve(
          fail('Too many active Chrome turns. End a Chrome turn before continuing.'),
        )
      this.turns.set(key, context.controller)
    }
    return this.dispatch(key, scope, params, context).catch((error: unknown) =>
      fail(
        error instanceof ChromeRouteError
          ? error.message
          : 'Chrome did not return a usable result. An operation may have executed; inspect first.',
      ),
    )
  }

  private async dispatch(
    key: string,
    scope: ChromeScope,
    params: ClientToolCallParams,
    context: Context,
  ): Promise<ClientToolCallResponse> {
    const controller = this.turns.get(key) ?? null
    const signal = context.signal
    signal.throwIfAborted()
    if (params.tool === 'targets') {
      const reply = controller?.ready()
        ? await controller.call({ ...params, litchChromeTargets: [] }, signal)
        : null
      signal.throwIfAborted()
      const local = this.runtime.status.enabled ? this.runtime.instances : []
      const desktop = reply?.success ? readObject(reply.contentItems[0])?.targets : null
      const targets = [
        ...(Array.isArray(desktop) && controller
          ? desktop.flatMap((target) => this.describeTarget(key, target, 'controller', controller))
          : []),
        ...local.flatMap((instance) =>
          this.describeTarget(
            key,
            {
              ...instance,
              targetId: `chrome:${instance.id}`,
              browser: 'chrome',
            },
            'sessionDevice',
            null,
          ),
        ),
      ]
      return {
        success: true,
        contentItems: [
          {
            type: 'inputText',
            text: JSON.stringify({
              targets,
              controller: controller?.ready()
                ? reply?.success
                  ? 'available'
                  : 'unavailable'
                : 'unavailable',
              sessionDevice: this.runtime.status.enabled
                ? this.runtime.status.condition
                : 'disabled',
              ...(targets.length
                ? {}
                : {
                    note: 'Enable Chrome in the relevant Litch settings and connect the extension on that computer.',
                  }),
            }),
          },
        ],
      }
    }

    const routes: Route[] = []
    const claims: string[] = []
    const tabs = new Map<string, BatchObservation>()
    const rewrite = (value: unknown): Record<string, unknown> => {
      if (!isObject(value)) throw new ChromeRouteError('Choose a Chrome handle from this turn.')
      const result = { ...value }
      const sameCall: Route[] = []
      for (const field of routeFields) {
        if (value[field] === undefined) continue
        const id = value[field]
        const handle = typeof id === 'string' ? this.handles.get(id) : null
        if (
          typeof id !== 'string' ||
          !handle ||
          handle.scope !== key ||
          handle.kind !== field ||
          handle.expires < Date.now()
        )
          throw new ChromeRouteError(
            'This Chrome handle is invalid or expired. List targets and claim again.',
          )
        result[field] = handle.raw
        sameCall.push(handle)
        if (field === 'claimToken') claims.push(id)
        if (field === 'tabId')
          tabs.set(handle.raw, { tabId: handle.raw, handle: id, route: handle })
      }
      const first = sameCall[0]
      if (!first)
        throw new ChromeRouteError('Choose an explicit Chrome target or tab from this turn.')
      if (sameCall.some((one) => !sameInstance(first, one)))
        throw new ChromeRouteError('Conflicting Chrome handles refer to different instances.')
      routes.push(...sameCall)
      return result
    }
    let args: Record<string, unknown>
    if (params.tool === 'run_actions') {
      const actions = isObject(params.arguments) ? params.arguments.actions : null
      if (!Array.isArray(actions) || actions.length < 1 || actions.length > 12)
        throw new ChromeRouteError('A browser batch must contain 1–12 actions.')
      args = {
        actions: actions.map((action) => {
          if (
            !isObject(action) ||
            typeof action.tool !== 'string' ||
            !isObject(action.arguments) ||
            !hasChrome(action.arguments, true)
          )
            throw new ChromeRouteError(
              'A batch must use handles from one browser execution end. Split the actions into separate calls.',
            )
          return { tool: action.tool, arguments: rewrite(action.arguments) }
        }),
      }
    } else args = rewrite(params.arguments)

    const route = routes[0]
    if (!route) throw new ChromeRouteError('Choose an explicit Chrome handle.')
    if (routes.some((one) => !sameEnd(route, one)))
      throw new ChromeRouteError(
        'A batch cannot span the controller and session device. Split the actions into separate calls.',
      )
    if (route.location === 'sessionDevice') {
      for (const one of routes) {
        const instance = this.runtime.instances.find((i) => `chrome:${i.id}` === one.target)
        const recovery = params.tool === 'ensure_claimed' && one.kind === 'tabId'
        if (
          !instance ||
          instance.stopped ||
          instance.protocol === null ||
          (!recovery && instance.epoch !== one.epoch)
        )
          throw new ChromeRouteError(
            'Device Chrome disconnected, stopped, or reconnected. List targets and claim again.',
          )
      }
    } else if (!route.controller?.ready())
      throw new ChromeRouteError(
        'The controller disconnected. Its Chrome handles cannot be used on another computer.',
      )
    let recoveryEpoch: string | undefined
    if (
      route.location === 'controller' &&
      params.tool === 'ensure_claimed' &&
      routes.some((one) => one.kind === 'tabId')
    ) {
      // 只刷新已绑定控制端的实例代次；原标签的 DevTools 身份仍由执行器核验。
      // 不沿用旧代次，也不允许刷新后与真正恢复之间再次重连而静默换绑。
      const listed = await route.controller?.call(
        { ...params, tool: 'targets', arguments: {}, callId: randomUUID(), litchChromeTargets: [] },
        signal,
      )
      signal.throwIfAborted()
      const targets = listed?.success ? readObject(listed.contentItems[0])?.targets : null
      const current = Array.isArray(targets)
        ? targets.find((item) => isObject(item) && item.targetId === route.target)
        : null
      if (
        !isObject(current) ||
        typeof current.epoch !== 'string' ||
        current.stopped === true ||
        current.protocol === null
      )
        throw new ChromeRouteError('The original controller Chrome instance is unavailable.')
      recoveryEpoch = current.epoch
    }
    if (
      route.location === 'sessionDevice' &&
      params.tool === 'request_sign_in' &&
      (await context.fullAccess())
    )
      return clientToolFailure(
        'failed',
        'Sign-in is required. Full access does not wait for manual login. Sign in on the device Chrome and retry.',
      )
    signal.throwIfAborted()
    // 一次性令牌必须在全部预检通过后消费，而且不会试发到另一个端。
    for (const id of claims) this.handles.delete(id)
    const call = { ...params, arguments: args }
    const reply =
      route.location === 'sessionDevice'
        ? await this.runtime.call(
            scope,
            call,
            new Set(routes.map((one) => one.target.slice(7))),
            signal,
            context.ask,
          )
        : await route.controller?.call(
            {
              ...call,
              litchChromeTargets: routes.map((one) => ({
                targetId: one.target,
                epoch: recoveryEpoch ?? one.epoch,
              })),
            },
            signal,
          )
    signal.throwIfAborted()
    if (!reply) throw new ChromeRouteError('The controller disconnected.')
    // 即使批次中途失败，已完成的步骤和最后一次安全观察也会返回。
    if (params.tool === 'run_actions') return this.transformBatch(reply, args, tabs)
    if (!reply.success) return reply
    return this.transform(
      reply,
      params.tool,
      args,
      {
        ...route,
        epoch: recoveryEpoch ?? route.epoch,
      },
      isObject(params.arguments) ? params.arguments.tabId : undefined,
    )
  }

  private transformBatch(
    reply: ClientToolCallResponse,
    args: Record<string, unknown>,
    tabs: ReadonlyMap<string, BatchObservation>,
  ): ClientToolCallResponse {
    const summary = readObject(reply.contentItems[0])
    const actions = args.actions
    if (!summary || !Array.isArray(summary.steps) || !Array.isArray(actions)) return reply
    const tabAt = (index: number): BatchObservation | undefined => {
      const action: unknown = actions[index]
      return isObject(action) &&
        isObject(action.arguments) &&
        typeof action.arguments.tabId === 'string'
        ? tabs.get(action.arguments.tabId)
        : undefined
    }
    const transform = (
      tool: string,
      items: ClientToolCallResponse['contentItems'],
      tab: BatchObservation,
    ) =>
      this.transform(
        { success: true, contentItems: items },
        tool,
        { tabId: tab.tabId },
        tab.route,
        tab.handle,
      )
    const steps = summary.steps.map((step: unknown, index: number) => {
      const tab = tabAt(index)
      if (
        !tab ||
        !isObject(step) ||
        step.success !== true ||
        (step.tool !== 'navigate' && step.tool !== 'wait') ||
        typeof step.text !== 'string'
      )
        return step
      const result = transform(step.tool, [{ type: 'inputText', text: step.text }], tab)
      return {
        ...step,
        text: result.contentItems
          .map((part) => (part.type === 'inputText' ? part.text : ''))
          .join('\n'),
      }
    })
    const [, marker, ...items] = reply.contentItems
    const last = tabAt(steps.length - 1)
    return {
      ...reply,
      contentItems: [
        { type: 'inputText', text: JSON.stringify({ ...summary, steps }) },
        ...(marker ? [marker] : []),
        ...(last &&
        marker?.type === 'inputText' &&
        marker.text === 'Final snapshot:' &&
        summary.observationStatus === 'completed'
          ? transform('snapshot', items, last).contentItems
          : items),
      ],
    }
  }

  private describeTarget(
    scope: string,
    item: unknown,
    location: Location,
    controller: ChromeController | null,
  ): Record<string, unknown>[] {
    if (!isObject(item) || typeof item.targetId !== 'string' || typeof item.epoch !== 'string')
      return []
    if (item.stopped === true || item.protocol === null) return []
    const targetId = this.issue({
      scope,
      location,
      controller,
      kind: 'targetId',
      target: item.targetId,
      raw: item.targetId,
      epoch: item.epoch,
      expires: Date.now() + 30 * 60_000,
    })
    const { id: _id, epoch: _epoch, extensionId: _extension, ...safe } = item
    return [
      {
        ...safe,
        targetId,
        location,
        hostLabel: controller?.hostLabel ?? this.runtime.status.hostLabel,
      },
    ]
  }

  private issue(route: Route): string {
    for (const [id, known] of this.handles) {
      if (known.expires < Date.now()) this.handles.delete(id)
      else if (
        known.scope === route.scope &&
        known.kind === route.kind &&
        known.raw === route.raw &&
        sameInstance(known, route)
      )
        return id
    }
    if (this.handles.size >= maxHandles)
      throw new ChromeRouteError('Too many live Chrome handles; end the turn and try again.')
    const handle = prefix + randomUUID()
    this.handles.set(handle, route)
    return handle
  }

  private transform(
    reply: ClientToolCallResponse,
    tool: string,
    args: Record<string, unknown>,
    route: Route,
    tabHandle: unknown,
  ): ClientToolCallResponse {
    const first = reply.contentItems[0]
    if (first?.type !== 'inputText') return reply
    // 只改写执行器生成的标题。网页正文可能含同样的文字，不能做全文替换。
    if (
      (tool === 'snapshot' || tool === 'screenshot' || tool === 'wait') &&
      typeof args.tabId === 'string' &&
      typeof tabHandle === 'string'
    ) {
      const offset =
        tool === 'wait' ? /^(?:Waited|Loaded|Found)\.\n/.exec(first.text)?.[0].length : 0
      const observed =
        offset === undefined ? first : observationHeader(first, args.tabId, tabHandle, offset)
      if (observed !== first)
        return { ...reply, contentItems: [observed, ...reply.contentItems.slice(1)] }
    }
    const head = first.text.indexOf('{')
    const tail = first.text.indexOf('\n', head)
    if (
      head < 0 ||
      !['claim', 'ensure_claimed', 'snapshot', 'tabs', 'navigate', 'show'].includes(tool)
    )
      return reply
    // snapshot 的正文来自页面；只改写执行器加在恢复响应之前的独立 JSON 元数据。
    if (tool === 'snapshot' && (head !== 0 || reply.contentItems.length < 2)) return reply
    const body = readObject({ ...first, text: first.text.slice(head, tail < 0 ? undefined : tail) })
    if (body === null) return reply
    const epoch =
      route.location === 'sessionDevice'
        ? (this.runtime.instances.find((i) => `chrome:${i.id}` === route.target)?.epoch ??
          route.epoch)
        : route.epoch
    const content = reply.contentItems.slice(1)
    if (tool === 'tabs' && args.action === 'list' && Array.isArray(body.tabs)) {
      body.tabs = body.tabs.map((tab) =>
        isObject(tab) && typeof tab.claimToken === 'string'
          ? {
              ...tab,
              claimToken: this.issue({
                ...route,
                epoch,
                kind: 'claimToken',
                raw: tab.claimToken,
                expires: Date.now() + 30_000,
              }),
            }
          : tab,
      )
    } else if (typeof body.tabId === 'string' && body.tabId.startsWith('chrome:')) {
      const raw = body.tabId
      const handle = this.issue({
        ...route,
        epoch,
        kind: 'tabId',
        raw,
        expires: Date.now() + 30 * 60_000,
      })
      body.tabId = handle
      // 重认领与快照自动恢复先返回 JSON，再返回独立快照。两处必须使用同一个新句柄。
      if ((tool === 'ensure_claimed' || tool === 'snapshot') && content[0])
        content[0] = observationHeader(content[0], raw, handle)
    } else return reply
    body.location = route.location
    body.hostLabel = route.controller?.hostLabel ?? this.runtime.status.hostLabel
    return {
      ...reply,
      contentItems: [
        {
          ...first,
          text: `${JSON.stringify(body)}${
            tool === 'navigate' || (tool === 'tabs' && args.action === 'new')
              ? `\nChrome and localhost are on the ${route.location === 'controller' ? 'controller' : 'session device'}.`
              : ''
          }`,
        },
        ...content,
      ],
    }
  }

  endTurn(harness: string, turnId: string): void {
    this.ended.add(JSON.stringify([harness, turnId]))
    if (this.ended.size > 16_384) this.ended.delete(this.ended.values().next().value ?? '')
    this.runtime.endTurn(harness, turnId)
    this.clear((h, _thread, turn) => h === harness && turn === turnId)
  }

  endSession(harness: string, threadId: string): void {
    this.runtime.endSession(harness, threadId)
    this.clear((h, thread) => h === harness && thread === threadId)
  }

  private clear(match: (harness: string, threadId: string, turnId: string) => boolean): void {
    const keys = new Set(
      [...this.turns.keys()].filter((key) => {
        const [harness, threadId, turnId] = JSON.parse(key) as [string, string, string]
        return match(harness, threadId, turnId)
      }),
    )
    for (const key of keys) this.turns.delete(key)
    for (const [id, route] of this.handles) if (keys.has(route.scope)) this.handles.delete(id)
  }
}

class ChromeRouteError extends Error {}

function observationHeader(
  item: ClientToolCallResponse['contentItems'][number],
  raw: string,
  handle: string,
  offset = 0,
): ClientToolCallResponse['contentItems'][number] {
  const prefix = `Tab ${raw}: `
  return item.type === 'inputText' && item.text.startsWith(prefix, offset)
    ? {
        ...item,
        text: `${item.text.slice(0, offset)}Tab ${handle}: ${item.text.slice(offset + prefix.length)}`,
      }
    : item
}

function readObject(
  item: ClientToolCallResponse['contentItems'][number] | undefined,
): Record<string, unknown> | null {
  if (item?.type !== 'inputText') return null
  try {
    const decoded: unknown = JSON.parse(item.text)
    return isObject(decoded) ? decoded : null
  } catch {
    return null
  }
}

export type { ChromeAsk }
