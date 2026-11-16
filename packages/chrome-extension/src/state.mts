import type {
  ChromeErrorCode,
  ChromeGrant,
  ChromeTabState,
} from '../../automation-contracts/src/litch/chrome-browser.mjs'
import { chromeOrigin } from './origin.mjs'
import type { TabPresentation } from './presentation.mjs'

export class ChromeFault extends Error {
  readonly code: ChromeErrorCode
  constructor(code: ChromeErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface ExtensionState {
  chrome: any
  keys: { attached: string; stopped: string; pointers: string; instance: string; control: string }
  pointerSource: string
  presentation: TabPresentation
  epoch: string
  grants: Map<string, ChromeGrant>
  tabLocks: Map<number, number>
  paused: Set<string>
  generations: Map<number, number>
  stoppedTurns: Set<string>
  /** 用户在扩展里主动停止控制，须由用户点扩展恢复。 */
  stopped: boolean
  /** 给代理看的提示里用的产品名。 */
  productName: string
  console: Map<number, Array<{ level: string; text: string; source: string; at: number }>>
  send(message: unknown): void
  revoke(leaseId: string, reason: string): Promise<void>
}

export function ownerKey(owner: ChromeGrant['owner']): string {
  return JSON.stringify([owner.deviceId, owner.threadId, owner.turnId])
}

export async function tabState(state: ExtensionState, id: number): Promise<ChromeTabState> {
  const tab = await state.chrome.tabs.get(id).catch(() => null)
  if (!tab || tab.incognito)
    throw new ChromeFault('targetUnavailable', 'The Chrome tab is unavailable or private.')
  return {
    id,
    title: tab.title ?? '',
    url: tab.pendingUrl || tab.url || 'about:blank',
    loading: tab.status === 'loading',
    generation: state.generations.get(id) ?? 0,
    ...(typeof tab.openerTabId === 'number' ? { openerTabId: tab.openerTabId } : {}),
  }
}

export async function framesOf(
  state: ExtensionState,
  tabId: number,
): Promise<Array<{ url: string; frameId: number; documentId: string }>> {
  const frames = await state.chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)
  if (!frames?.length)
    throw new ChromeFault(
      'staleDocument',
      'Chrome is changing this document; wait for navigation to settle.',
    )
  return frames
}

export async function inspectOrigins(state: ExtensionState, tabId: number): Promise<string[]> {
  const tab = await tabState(state, tabId)
  const origin = chromeOrigin(tab.url)
  if (!origin)
    throw new ChromeFault(
      'targetUnavailable',
      'Only HTTP(S) and about:blank tabs can be controlled.',
    )
  const frames = await framesOf(state, tabId)
  const origins = new Set<string>([origin])
  for (const frame of frames) {
    if (frame.url === 'about:blank' || frame.url === 'about:srcdoc') continue
    const next = chromeOrigin(frame.url)
    if (!next)
      throw new ChromeFault(
        'originNotApproved',
        'A frame has an unsupported origin; this page cannot be observed safely.',
      )
    origins.add(next)
  }
  return [...origins]
}

export async function documentStamp(state: ExtensionState, grant: ChromeGrant): Promise<string> {
  const tab = await tabState(state, grant.tabId)
  const frames = await framesOf(state, grant.tabId)
  const origins = await inspectOrigins(state, grant.tabId)
  const missing = origins.find((origin) => !grant.origins.includes(origin))
  if (missing)
    throw new ChromeFault(
      'staleDocument',
      `The page added origin ${missing} during this operation. No page content was returned. Call snapshot to check the current website permissions; do not repeat input that may have executed.`,
    )
  return JSON.stringify([
    tab.url,
    tab.generation,
    frames.map((frame) => [frame.frameId, frame.documentId, frame.url]).sort(),
  ])
}

export async function requireGrant(
  state: ExtensionState,
  leaseId?: string,
  generation?: number,
): Promise<ChromeGrant> {
  if (state.stopped)
    throw new ChromeFault(
      'userStopped',
      `The user stopped Chrome control. Ask the user to click the ${state.productName} extension to resume control.`,
    )
  const grant = leaseId ? state.grants.get(leaseId) : null
  if (!grant || grant.expiresAt <= Date.now())
    throw new ChromeFault(
      'staleLease',
      'The Chrome lease expired or was revoked. List tabs and claim again.',
    )
  if (state.paused.size)
    throw new ChromeFault(
      'signingIn',
      'The user is signing in. All observation and input are paused.',
    )
  if (generation !== undefined && generation !== (state.generations.get(grant.tabId) ?? 0))
    throw new ChromeFault(
      'staleDocument',
      'The document changed. Take a fresh snapshot before acting.',
    )
  await documentStamp(state, grant)
  if (state.grants.get(grant.leaseId) !== grant || grant.expiresAt <= Date.now())
    throw new ChromeFault('staleLease', 'The lease was revoked during validation.')
  if (state.paused.size) throw new ChromeFault('signingIn', 'Chrome was paused during validation.')
  if (generation !== undefined && generation !== (state.generations.get(grant.tabId) ?? 0))
    throw new ChromeFault('staleDocument', 'The document changed during validation.')
  return grant
}

export async function targetIdOf(state: ExtensionState, tabId: number): Promise<string> {
  const targets: Array<{ tabId?: number; id: string }> = await state.chrome.debugger.getTargets()
  const target = targets.find((target) => target.tabId === tabId)
  if (!target || !/^[a-fA-F0-9]{32}$/.test(target.id))
    throw new ChromeFault(
      'staleDocument',
      'Chrome target identity is unavailable. List tabs again.',
    )
  return target.id
}

export async function attach(
  state: ExtensionState,
  tabId: number,
  expectedTargetId?: string,
): Promise<void> {
  // Chrome 可让多个扩展同时 attach；不能依靠 attach 自动拒绝已经存在的调试器。
  // 合作宿主先在原生层取得文件锁；此检查同时保护未加入锁约定的其他调试器。
  const targets: Array<{ tabId?: number; attached: boolean; id?: string }> =
    await state.chrome.debugger.getTargets()
  if (
    expectedTargetId &&
    !targets.some((target) => target.tabId === tabId && target.id === expectedTargetId)
  )
    throw new ChromeFault(
      'staleDocument',
      'Chrome target changed before attaching. List tabs again.',
    )
  if (targets.some((target) => target.tabId === tabId && target.attached))
    throw new ChromeFault(
      'busy',
      'Another debugger is already attached to this Chrome tab. Release it before claiming; do not take over its connection.',
    )
  let attached = false
  try {
    await state.chrome.debugger.attach({ tabId }, '1.3')
    attached = true
    const current: Array<{ tabId?: number; attached: boolean }> =
      await state.chrome.debugger.getTargets()
    if (!current.some((target) => target.tabId === tabId && target.attached))
      throw new Error('Chrome target disappeared after attach')
  } catch {
    if (attached) await state.chrome.debugger.detach({ tabId }).catch(() => {})
    throw new ChromeFault(
      'targetUnavailable',
      'Chrome cannot attach to this tab. Close its DevTools or another debugger, then claim again.',
    )
  }
}

export function cdp(
  state: ExtensionState,
  tabId: number,
  method: string,
  params: unknown = {},
): Promise<any> {
  return state.chrome.debugger.sendCommand({ tabId }, method, params)
}

export async function saveAttached(state: ExtensionState): Promise<void> {
  await state.chrome.storage.session.set({
    [state.keys.attached]: [...state.grants.values()].map((grant) => grant.tabId),
    [state.keys.pointers]: [...state.grants.values()].map(({ tabId, leaseId }) => ({
      tabId,
      leaseId,
    })),
  })
}

export function lockTab(state: ExtensionState, tabId: number): () => void {
  state.tabLocks.set(tabId, (state.tabLocks.get(tabId) ?? 0) + 1)
  return () => {
    const count = (state.tabLocks.get(tabId) ?? 1) - 1
    if (count) state.tabLocks.set(tabId, count)
    else state.tabLocks.delete(tabId)
  }
}
