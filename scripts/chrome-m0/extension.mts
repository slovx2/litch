// 仅供隔离 M0：探测 Chrome API，不是可发布的扩展或模型工具。
import {
  type AutomationPointerSample,
  type AutomationSurface,
  isCurrentAutomationPointer,
} from '../../packages/protocol/src/automation-surface.mts'
import { popupProbe } from './popup-extension.mts'

declare const chrome: any
const epoch = crypto.randomUUID()
const leases = new Set<number>()
const events: unknown[] = []
const allowedOrigins = new Map<number, Set<string>>()
const attachedFrames = new Map<number, Set<string>>()
const popupMode = popupProbe(chrome, cdp, evaluate, events)
chrome.runtime.onMessage.addListener(
  (_message: unknown, _sender: unknown, respond: (reply: unknown) => void) => {
    respond({ epoch })
  },
)
// 注册生命周期事件以便 Chrome 在更新/启动时唤醒 MV3 worker。
chrome.runtime.onInstalled.addListener(() => {})
chrome.runtime.onStartup.addListener(() => {})

function cdp(tabId: number, method: string, params: unknown = {}, sessionId?: string) {
  return chrome.debugger.sendCommand({ tabId, ...(sessionId ? { sessionId } : {}) }, method, params)
}

async function evaluate(tabId: number, expression: string, contextId?: number, sessionId?: string) {
  const result = await cdp(
    tabId,
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...(contextId ? { contextId } : {}),
    },
    sessionId,
  )
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

// 一次性几何标记，只验证页面承载、截图排除；正式动画由 CU 公共渲染器提供。
function installMarker() {
  const previous = document.getElementById('litch-m0-marker')
  previous?.remove()
  const host = document.createElement('div')
  host.id = 'litch-m0-marker'
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none'
  host.setAttribute('aria-hidden', 'true')
  const root = host.attachShadow({ mode: 'closed' })
  const dot = document.createElement('div')
  dot.textContent = 'M0'
  dot.style.cssText =
    'position:absolute;width:48px;height:48px;border-radius:50%;background:#ff00ff;color:white;pointer-events:none'
  root.append(dot)
  document.documentElement.append(host)
  ;(globalThis as any).m0Marker = {
    move(x: number, y: number) {
      dot.style.transform = `translate(${x}px,${y}px)`
    },
    visible(show: boolean) {
      host.style.display = show ? '' : 'none'
    },
    dispose() {
      host.remove()
    },
  }
}

chrome.debugger.onEvent.addListener(async (source: any, method: string, params: any) => {
  if (method === 'Target.attachedToTarget') {
    const frames = attachedFrames.get(source.tabId) ?? new Set<string>()
    frames.add(params.sessionId)
    attachedFrames.set(source.tabId, frames)
  }
  if (method === 'Fetch.requestPaused' && allowedOrigins.has(source.tabId)) {
    const origins = allowedOrigins.get(source.tabId)
    const blocked = origins && !origins.has(new URL(params.request.url).origin)
    events.push({ method, tabId: source.tabId, url: params.request.url, blocked: !!blocked })
    try {
      await cdp(
        source.tabId,
        blocked ? 'Fetch.failRequest' : 'Fetch.continueRequest',
        {
          requestId: params.requestId,
          ...(blocked ? { errorReason: 'BlockedByClient' } : {}),
        },
        source.sessionId,
      )
    } catch (error) {
      events.push({ error: String(error) })
    }
  }
})
chrome.debugger.onDetach.addListener((source: any, reason: string) => {
  leases.delete(source.tabId)
  events.push({ method: 'detach', tabId: source.tabId, reason })
})

async function run(op: string, args: any): Promise<unknown> {
  switch (op) {
    case 'ping':
      return { epoch, permissions: await chrome.permissions.getAll(), leases: [...leases] }
    case 'popupMode':
      return popupMode(args)
    case 'close':
      return chrome.tabs.remove(args.tabId)
    case 'echo':
      return { length: args.text.length, text: args.text }
    case 'tabs':
      return (await chrome.tabs.query({})).map((tab: any) => ({
        id: tab.id,
        url: tab.url,
        active: tab.active,
      }))
    case 'new':
      return chrome.tabs.create({ url: args.url, active: args.active ?? true })
    case 'activate':
      return chrome.tabs.update(args.tabId, { active: true })
    case 'navigate':
      return chrome.tabs.update(args.tabId, { url: args.url })
    case 'zoom':
      return chrome.tabs.setZoom(args.tabId, args.factor)
    case 'reloadExtension':
      setTimeout(() => chrome.runtime.reload(), 100)
      return true
    case 'events':
      return events.splice(0)
    case 'attach':
      await chrome.debugger.attach({ tabId: args.tabId }, '1.3')
      leases.add(args.tabId)
      await chrome.storage.session.set({ m0Attached: [...leases] })
      await cdp(args.tabId, 'Runtime.enable')
      await cdp(args.tabId, 'Page.enable')
      return true
    case 'autoFrames':
      return cdp(args.tabId, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
    case 'release':
      leases.delete(args.tabId)
      await chrome.debugger.detach({ tabId: args.tabId })
      await chrome.storage.session.set({ m0Attached: [...leases] })
      return true
    case 'frames':
      return {
        sessions: [...(attachedFrames.get(args.tabId) ?? [])],
        tree: await cdp(args.tabId, 'Page.getFrameTree'),
      }
    case 'guard':
      allowedOrigins.set(args.tabId, new Set(args.origins))
      await cdp(args.tabId, 'Fetch.enable', {
        patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
      })
      return true
    case 'unguard':
      allowedOrigins.delete(args.tabId)
      return cdp(args.tabId, 'Fetch.disable')
    case 'marker': {
      const { frameTree } = await cdp(args.tabId, 'Page.getFrameTree')
      const { executionContextId } = await cdp(args.tabId, 'Page.createIsolatedWorld', {
        frameId: frameTree.frame.id,
        worldName: 'litch-m0-only',
      })
      await evaluate(args.tabId, `(${installMarker.toString()})()`, executionContextId)
      return executionContextId
    }
    case 'pointer': {
      const surface: AutomationSurface = args.surface
      const sample: AutomationPointerSample = args.sample
      if (!isCurrentAutomationPointer(surface, sample, args.previous))
        throw new Error('过期光标事件')
      if (sample.position)
        await evaluate(
          args.tabId,
          `m0Marker.move(${sample.position.x},${sample.position.y})`,
          args.contextId,
        )
      return true
    }
    case 'evaluate':
      return evaluate(args.tabId, args.expression, args.contextId, args.sessionId)
    case 'cdp':
      if (!leases.has(args.tabId)) throw new Error('没有 M0 调试租约')
      return cdp(args.tabId, args.method, args.params, args.sessionId)
    default:
      throw new Error(`未知探针操作：${op}`)
  }
}
async function startNative() {
  // worker 被强停时 onDisconnect 未必执行；只撤本扩展先前明确登记的调试器。
  const stale = await chrome.storage.session.get('m0Attached')
  for (const tabId of stale.m0Attached ?? [])
    await chrome.debugger.detach({ tabId }).catch(() => {})
  await chrome.storage.session.remove('m0Attached')
  const port = chrome.runtime.connectNative('ai.litch.chrome_m0')
  port.onDisconnect.addListener(() => {
    ;(globalThis as any).m0NativeError = chrome.runtime.lastError?.message ?? 'disconnected'
    for (const tabId of leases) chrome.debugger.detach({ tabId }).catch(() => {})
    leases.clear()
  })
  port.onMessage.addListener((message: any) => {
    run(message.op, message.args ?? {}).then(
      (result) => port.postMessage({ id: message.id, result }),
      (error) => port.postMessage({ id: message.id, error: String(error) }),
    )
  })
  port.postMessage({ ready: true, epoch, extensionId: chrome.runtime.id })
}
startNative().catch(console.error)
