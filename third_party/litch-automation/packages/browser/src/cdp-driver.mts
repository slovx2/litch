// CDP 实现只依赖页面端口；复用同一套读写/遮罩工具，不再维护第二套网页操作。
import { randomUUID } from 'node:crypto'
import type {
  BrowserAction,
  BrowserDriver,
  BrowserEvent,
  BrowserObservation,
  BrowserOperation,
  BrowserPageInfo,
} from '../../automation-contracts/src/browser.mjs'
import type { JsonValue, SessionScope } from '../../automation-contracts/src/runtime.mjs'
import { newRefBook } from './browser/ax.mjs'
import type { Call, TabState } from './browser/executor.mjs'
import { guardedPage } from './browser/guarded-page.mjs'
import type { BrowserPage } from './browser/model.mjs'
import { imageSize } from './browser/page-ops.mjs'
import { sessionKey } from './browser/sites.mjs'
import { TOOLS } from './browser/tools.mjs'
import { isOpenable, needsApproval, originOf } from './browser/url.mjs'
import type { BrowserDriverRuntime, CdpDriverOptions } from './ports.mjs'
import type { ClientToolCallResponse } from './tool-port.mjs'

interface RecordState {
  page: BrowserPage
  state: TabState
  document?: string
  geometry?: string
  observation: BrowserObservation
}

export function createCdpDriver(options: CdpDriverOptions): BrowserDriverRuntime {
  const { host, sites } = options
  const records = new Map<string, RecordState>()
  const turns = new Map<string, string>()
  const listeners = new Set<(event: BrowserEvent) => void>()
  const frozen = new Map<string, { token: string; owner: string }>()
  const hidden = (id: string) =>
    frozen.has(id) || options.handover?.active(id) || options.browserHandover?.hides(id)
  let disposed = false
  const emit = (event: BrowserEvent) => {
    for (const fn of listeners) fn(event)
  }
  const ownerKey = (owner: SessionScope) =>
    JSON.stringify([owner.hostId, owner.deviceId, owner.sessionId])
  const scopeCheck = (operation: BrowserOperation) => {
    operation.signal.throwIfAborted()
    if (disposed || operation.scope.hostId !== options.hostId)
      throw new Error('Browser host is unavailable or belongs to another host.')
  }
  const permitted = (page: BrowserPage, url: string, turn: string) => {
    const approve = options.requiresApproval ?? needsApproval
    if (!approve(url)) return true
    const origin = originOf(url),
      owner = page.info().owner
    return (
      !!origin &&
      sites.verdict(sessionKey(owner.deviceId, owner.threadId), turn, origin) === 'allow'
    )
  }
  let extraGate: (page: BrowserPageInfo, url: string) => boolean = () => true
  host.setNavigationGate((page, url) => {
    const owner = page.info().owner
    return (
      permitted(page, url, turns.get(sessionKey(owner.deviceId, owner.threadId)) ?? '') &&
      extraGate(info(page), url)
    )
  })
  const pageFor = (id: string, operation: BrowserOperation, allowFrozen = false) => {
    scopeCheck(operation)
    const page = host.page(id),
      scope = operation.scope
    if (
      !page ||
      page.info().owner.deviceId !== scope.deviceId ||
      page.info().owner.threadId !== scope.sessionId ||
      page.info().kind !== 'agent'
    )
      throw new Error('Page is not owned by this session.')
    if (!allowFrozen && hidden(id)) throw new Error('The user is signing in on this tab.')
    turns.set(sessionKey(scope.deviceId, scope.sessionId), scope.turnId)
    return page
  }
  const record = (page: BrowserPage): RecordState => {
    let value = records.get(page.id)
    if (!value || value.page !== page) {
      value = {
        page,
        state: { book: newRefBook(), lastSnapshot: null, shotScale: 1, forwardNote: null },
        observation: { pageId: page.id, generation: randomUUID(), geometryRevision: randomUUID() },
      }
      records.set(page.id, value)
    }
    return value
  }
  const stamp = async (
    page: BrowserPage,
    operation: BrowserOperation,
    expected?: BrowserObservation,
  ) => {
    const check = () => {
      if (pageFor(page.id, operation) !== page)
        throw new Error('The page changed. Observe again before acting.')
      if (!permitted(page, page.info().url, operation.scope.turnId))
        throw new Error('The source has not been approved.')
    }
    check()
    const value = record(page)
    const document = JSON.stringify(
      await abortable(page.cdp('Page.getFrameTree'), operation.signal),
    )
    check()
    const geometry = JSON.stringify(
      await abortable(page.cdp('Page.getLayoutMetrics'), operation.signal),
    )
    check()
    if (value.document !== document) {
      value.state.book = newRefBook()
      value.state.lastSnapshot = null
      value.observation = { ...value.observation, generation: randomUUID() }
      emit({ kind: 'invalidated', pageId: page.id, reason: 'navigation' })
    }
    if (value.geometry !== geometry)
      value.observation = { ...value.observation, geometryRevision: randomUUID() }
    value.document = document
    value.geometry = geometry
    if (
      expected &&
      (expected.pageId !== page.id ||
        expected.generation !== value.observation.generation ||
        expected.geometryRevision !== value.observation.geometryRevision)
    )
      throw new Error('The document or geometry changed. Observe again before acting.')
    return value
  }
  const info = (page: BrowserPage): BrowserPageInfo => {
    const one = page.info(),
      concealed = hidden(page.id)
    return {
      id: one.id,
      kind: one.kind,
      url: concealed ? '' : one.url,
      title: concealed ? '' : one.title,
      loading: concealed ? false : one.loading,
      owner: {
        hostId: options.hostId,
        deviceId: one.owner.deviceId,
        sessionId: one.owner.threadId,
      },
    }
  }
  const off = options.onChange?.(() => {
    for (const [id] of records)
      if (!host.page(id)) {
        records.delete(id)
        frozen.delete(id)
        emit({ kind: 'closed', pageId: id })
      }
    for (const page of host.pages()) emit({ kind: 'changed', page: info(page) })
  })
  async function invoke(
    id: string,
    tool: string,
    args: Record<string, unknown>,
    operation: BrowserOperation,
    expected?: BrowserObservation,
  ): Promise<ClientToolCallResponse> {
    const raw = pageFor(id, operation),
      value = record(raw)
    if (!permitted(raw, raw.info().url, operation.scope.turnId))
      throw new Error('The source has not been approved.')
    if (expected) await stamp(raw, operation, expected)
    const check = async () => {
      pageFor(id, operation)
      if (host.page(id) !== raw || !permitted(raw, raw.info().url, operation.scope.turnId))
        throw new Error('Page or source permission changed.')
      if (expected) await stamp(raw, operation, expected)
    }
    raw.setAgentActive(true)
    const wrapped = guardedPage(
      raw,
      check,
      expected ? value.document : undefined,
      () => {
        records.delete(id)
      },
      !expected,
    )
    const page = wrapped.page,
      scope = operation.scope
    const kit: Call = {
      invocation: {
        id: scope.callId,
        callId: scope.callId,
        threadId: scope.sessionId,
        turnId: scope.turnId,
        namespace: 'litch_browser',
        tool,
        arguments: args,
        device: { id: scope.deviceId, name: scope.deviceId, kind: 'local', target: null },
        harness: null,
        cwd: null,
      },
      context: { signal: operation.signal, ask: async () => null },
      args,
      owner: raw.info().owner,
      host,
      resolveUrl: async (url) => url,
      describeUrl: () => null,
      pick: () => page,
      pickMaybe: () => page,
      current: () => page,
      setCurrent: () => {},
      state: () => value.state,
      admit: async (url) =>
        permitted(raw, url, scope.turnId)
          ? null
          : { success: false, contentItems: [{ type: 'inputText', text: 'Source not approved.' }] },
      admitPage: async (target) => {
        await check()
        return permitted(raw, target.info().url, scope.turnId)
          ? null
          : { success: false, contentItems: [] }
      },
      done: (_page, text, images = []) => ({
        success: true,
        contentItems: [
          { type: 'inputText', text },
          ...images.map((imageUrl) => ({ type: 'inputImage' as const, imageUrl })),
        ],
      }),
      statFile: options.statFile ?? (() => null),
      handover: options.browserHandover ?? null,
    }
    const fn = TOOLS[tool]
    if (!fn) throw new Error('Unsupported browser operation.')
    const result = await abortable(fn(kit), operation.signal)
    await check()
    if (!result.success)
      throw new Error(
        result.contentItems
          .filter((item) => item.type === 'inputText')
          .map((item) => item.text)
          .join('\n'),
      )
    return result
  }
  const textOf = (result: ClientToolCallResponse) =>
    result.contentItems
      .filter((one) => one.type === 'inputText')
      .map((one) => one.text)
      .join('\n')
  const dispose = async () => {
    if (disposed) return
    disposed = true
    off?.()
    for (const page of host.pages()) if (page.info().kind === 'agent') host.close(page.id)
    records.clear()
    frozen.clear()
    listeners.clear()
  }
  const driver: BrowserDriver = {
    capabilities: {
      snapshot: true,
      screenshot: true,
      trustedInput: true,
      evaluate: true,
      upload: !!options.statFile,
      console: true,
      dialogs: true,
      manualSignIn: !!options.handover,
      credentialFill: false,
    },
    pages: () => (disposed ? [] : host.pages().map(info)),
    subscribe: (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    async open(owner, prefs, operation) {
      scopeCheck(operation)
      if (ownerKey(owner) !== ownerKey(operation.scope)) throw new Error('Owner mismatch.')
      return host.open({ deviceId: owner.deviceId, threadId: owner.sessionId }, prefs.kind, {
        keep: prefs.keep,
      }).id
    },
    async close(id, op) {
      pageFor(id, op)
      host.close(id)
      records.delete(id)
    },
    async setKeep(id, keep, op) {
      pageFor(id, op)
      host.setKeep(id, keep)
    },
    async release(id, op) {
      pageFor(id, op)
      host.release(id)
      records.delete(id)
    },
    async navigate(id, url, timeout, op) {
      const page = pageFor(id, op)
      if (!isOpenable(url) || !permitted(page, url, op.scope.turnId) || !extraGate(info(page), url))
        throw new Error('Navigation source not approved.')
      page.setAgentActive(true)
      const loaded = await abortable(page.load(url, timeout), op.signal)
      pageFor(id, op)
      records.delete(id)
      return loaded.ok ? { ok: true } : { ok: false, reason: loaded.error ?? 'Navigation failed.' }
    },
    async history(id, action, timeout, op) {
      const page = pageFor(id, op)
      if (!permitted(page, page.info().url, op.scope.turnId))
        throw new Error('The source has not been approved.')
      page.setAgentActive(true)
      const loaded = await abortable(page.history(action, timeout), op.signal)
      pageFor(id, op)
      records.delete(id)
      return loaded.ok ? { ok: true } : { ok: false, reason: loaded.error ?? 'Navigation failed.' }
    },
    async snapshot(id, diff, op) {
      const page = pageFor(id, op)
      const before = (await stamp(page, op)).observation
      const result = await invoke(id, 'snapshot', { diff }, op)
      const value = await stamp(page, op, before)
      return {
        observation: value.observation,
        text: textOf(result),
        truncated: textOf(result).includes('this snapshot was cut'),
      }
    },
    async screenshot(id, format, op) {
      const page = pageFor(id, op)
      const before = (await stamp(page, op)).observation
      const result = await invoke(id, 'screenshot', { format }, op)
      const image = result.contentItems.find((one) => one.type === 'inputImage')
      if (image?.type !== 'inputImage') throw new Error('Screenshot unavailable.')
      const data = image.imageUrl.split(',')[1] ?? ''
      const size = imageSize(Buffer.from(data, 'base64'))
      if (!size) throw new Error('Invalid screenshot.')
      return {
        observation: (await stamp(page, op, before)).observation,
        mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
        data,
        ...size,
      }
    },
    async act(observed, action, op) {
      await invoke(observed.pageId, action.kind, actionArgs(action), op, observed)
    },
    async evaluate(observed, expression, op) {
      const text = textOf(await invoke(observed.pageId, 'evaluate', { expression }, op, observed))
      try {
        return JSON.parse(text) as JsonValue
      } catch {
        return text
      }
    },
    async console(id, prefs, op) {
      return [textOf(await invoke(id, 'console', prefs, op))]
    },
    async wait(id, condition, op) {
      await invoke(
        id,
        'wait',
        {
          for: condition.kind,
          timeoutMs: condition.timeoutMs,
          ...(condition.kind === 'time' ? { ms: condition.timeoutMs } : {}),
          ...(condition.value ? { [condition.kind]: condition.value } : {}),
        },
        op,
      )
      return true
    },
    setNavigationGate: (gate) => {
      extraGate = gate
    },
    async freeze(id, op) {
      const page = pageFor(id, op)
      if (!permitted(page, page.info().url, op.scope.turnId))
        throw new Error('The source has not been approved.')
      if (!options.handover) throw new Error('No trusted handover installed.')
      const pending = { token: randomUUID(), owner: ownerKey(op.scope) }
      frozen.set(id, pending)
      const token = await options.handover.freeze(id)
      if (frozen.get(id) !== pending || disposed) throw new Error('Handover was cancelled.')
      frozen.set(id, { token, owner: ownerKey(op.scope) })
      records.delete(id)
      scopeCheck(op)
      return token
    },
    async unfreeze(id, token, op) {
      pageFor(id, op, true)
      const one = frozen.get(id)
      if (!one || one.token !== token || one.owner !== ownerKey(op.scope) || !options.handover)
        throw new Error('Invalid handover.')
      await options.handover.unfreeze(id, token)
      scopeCheck(op)
      frozen.delete(id)
      records.delete(id)
    },
    async flushStorage(signal) {
      signal.throwIfAborted()
      await options.flushStorage?.(signal)
    },
    async endSession(owner) {
      if (owner.hostId !== options.hostId) throw new Error('Host mismatch.')
      for (const page of host.pages())
        if (ownerKey(info(page).owner) === ownerKey(owner) && page.info().kind === 'agent') {
          host.close(page.id)
          records.delete(page.id)
          frozen.delete(page.id)
        }
      turns.delete(sessionKey(owner.deviceId, owner.sessionId))
    },
    dispose,
  }
  return {
    driver,
    show: (id) => {
      if (!disposed && !hidden(id)) host.show(id)
    },
    dispose,
  }
}

function actionArgs(action: BrowserAction): Record<string, unknown> {
  const target = 'target' in action ? action.target : null
  const where =
    target?.kind === 'element' ? { ref: target.ref } : target ? { x: target.x, y: target.y } : {}
  switch (action.kind) {
    case 'click':
      if (![1, 2].includes(action.count)) throw new Error('Unsupported click count.')
      return { ...where, button: action.button, double: action.count === 2 }
    case 'type':
      return { ...where, text: action.text, clear: action.clear, submit: action.submit }
    case 'scroll':
      return { ...where, dx: action.dx, dy: action.dy }
    case 'press':
      return { key: action.key }
    case 'dialog':
      return { accept: action.accept, ...(action.text === undefined ? {} : { text: action.text }) }
    case 'upload':
      return { ref: action.ref, paths: [...action.fileHandles] }
  }
}

/** 停止立即交还宿主；guardedPage 仍会挡住已启动异步工作的后续输入。 */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(new Error('The call was cancelled; a dispatched action may have executed.'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
