import type { ChromeGrant, ChromeRequest } from '../../../packages/protocol/src/chrome-browser.mjs'
import { isAllowedCdp } from '../../desktop/src/browser/cdp-allow.mjs'
import { chromeOrigin } from './origin.mjs'
import { disposePointer, planPointer, pointerCommand, withoutPointer } from './pointer.mjs'
import {
  attach,
  ChromeFault,
  cdp,
  documentStamp,
  type ExtensionState,
  inspectOrigins,
  lockTab,
  ownerKey,
  requireGrant,
  saveAttached,
  tabState,
} from './state.mjs'

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new ChromeFault('invalid', 'Invalid Chrome tab.')
  return value
}

function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new ChromeFault('invalid', 'Missing argument.')
  return value
}

export async function execute(state: ExtensionState, request: ChromeRequest): Promise<unknown> {
  if (request.epoch !== state.epoch)
    throw new ChromeFault('staleLease', 'Chrome reconnected. List targets and claim again.')
  const args = request.args
  if (state.paused.size && !['renew', 'release', 'stop', 'unfreeze'].includes(request.op))
    throw new ChromeFault('signingIn', 'The user is signing in. This Chrome instance is paused.')
  if (request.op === 'list') {
    const tabs = await state.chrome.tabs.query({})
    const result = await Promise.all(
      tabs
        .filter((tab: any) => !tab.incognito && chromeOrigin(tab.pendingUrl || tab.url || ''))
        .map(async (tab: any) => ({
          ...(await tabState(state, tab.id)),
          origins: await inspectOrigins(state, tab.id).catch(() => []),
          busy: [...state.grants.values()].some((grant) => grant.tabId === tab.id),
        })),
    )
    if (state.paused.size)
      throw new ChromeFault('signingIn', 'Chrome was paused while listing tabs.')
    return result
  }
  if (request.op === 'new') {
    const tab = await state.chrome.tabs.create({ url: 'about:blank', active: false })
    // 等新建空白页的首次提交完成，避免马上 claim 拿到上一代文档。
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      const current = await tabState(state, tab.id)
      if (!current.loading && current.generation > 0) return current
    }
    return tabState(state, tab.id)
  }
  if (request.op === 'claim') {
    const grant = args.grant as ChromeGrant
    if (
      !grant ||
      typeof grant.leaseId !== 'string' ||
      !grant.owner ||
      !Array.isArray(grant.origins)
    )
      throw new ChromeFault('invalid', 'Invalid lease.')
    number(grant.tabId)
    if (state.stoppedTurns.has(ownerKey(grant.owner)))
      throw new ChromeFault('cancelled', 'The user stopped Chrome control for this turn.')
    const existing = [...state.grants.values()].find((one) => one.tabId === grant.tabId)
    if (existing || state.tabLocks.has(grant.tabId))
      throw new ChromeFault('busy', 'This Chrome tab is already claimed.')
    const unlock = lockTab(state, grant.tabId)
    grant.expiresAt = Date.now() + 15_000
    state.grants.set(grant.leaseId, grant)
    let attached = false
    try {
      const tab = await tabState(state, grant.tabId)
      if (tab.loading || tab.url !== args.expectedUrl || tab.generation !== args.expectedGeneration)
        throw new ChromeFault('staleDocument', 'The selected tab changed. List tabs again.')
      await saveAttached(state)
      await documentStamp(state, grant)
      await attach(state, grant.tabId)
      attached = true
      await requireGrant(state, grant.leaseId, args.expectedGeneration as number)
      grant.expiresAt = Date.now() + 15_000
      await saveAttached(state)
      await cdp(state, grant.tabId, 'Page.enable')
      await cdp(state, grant.tabId, 'Runtime.enable')
      const current = await tabState(state, grant.tabId)
      await requireGrant(state, grant.leaseId, args.expectedGeneration as number)
      return { tab: current, leaseId: grant.leaseId }
    } catch (error) {
      state.grants.delete(grant.leaseId)
      if (attached) await state.chrome.debugger.detach({ tabId: grant.tabId }).catch(() => {})
      await saveAttached(state)
      throw error
    } finally {
      unlock()
    }
  }
  const grant = request.leaseId ? state.grants.get(request.leaseId) : undefined
  if (!grant)
    throw new ChromeFault(
      'staleLease',
      'The Chrome lease is no longer valid. List tabs and claim again.',
    )
  if (request.op === 'release' || request.op === 'stop') {
    if (request.op === 'stop') {
      state.stoppedTurns.add(ownerKey(grant.owner))
      await state.chrome.storage.session.set({
        litchStoppedTurns: [...state.stoppedTurns].slice(-100),
      })
    }
    await state.revoke(grant.leaseId, request.op)
    if (args.close === true && !grant.original && !grant.keep)
      await state.chrome.tabs.remove(grant.tabId).catch(() => {})
    return null
  }
  if (request.op === 'renew') {
    if (grant.expiresAt <= Date.now())
      throw new ChromeFault('staleLease', 'The lease expired. Claim again.')
    if (state.stoppedTurns.has(ownerKey(grant.owner)))
      throw new ChromeFault('cancelled', 'The user stopped this turn.')
    grant.expiresAt = Date.now() + 15_000
    return null
  }
  if (grant.expiresAt <= Date.now())
    throw new ChromeFault('staleLease', 'The lease expired. Claim again.')
  if (state.stoppedTurns.has(ownerKey(grant.owner)))
    throw new ChromeFault('cancelled', 'The user stopped this turn.')
  if (request.op === 'authorize') {
    if (
      !Array.isArray(args.origins) ||
      args.origins.some((origin) => typeof origin !== 'string' || chromeOrigin(origin) !== origin)
    )
      throw new ChromeFault('invalid', 'Invalid approved origins.')
    grant.origins = args.origins as string[]
    if (typeof args.keep === 'boolean') grant.keep = grant.original || args.keep
    return null
  }
  if (request.op === 'freeze') {
    await requireGrant(state, grant.leaseId, request.generation)
    if (state.paused.size)
      throw new ChromeFault('signingIn', 'Chrome is already paused for sign-in.')
    state.paused.add(grant.leaseId)
    state.console.clear()
    await disposePointer(state, grant)
    const tab = await state.chrome.tabs.update(grant.tabId, { active: true })
    await state.chrome.windows.update(tab.windowId, { focused: true })
    return null
  }
  if (request.op === 'unfreeze') {
    // 人交还后重新载入，清掉本轮表单输入与旧上下文；随后桌面释放租约并要求重新 claim。
    await state.chrome.tabs.reload(grant.tabId)
    return tabState(state, grant.tabId)
  }
  await requireGrant(state, grant.leaseId, request.generation)
  if (request.op === 'console') {
    const entries = state.console.get(grant.tabId) ?? []
    if (args.clear === true) state.console.delete(grant.tabId)
    return entries
  }
  if (request.op === 'show') {
    const tab = await state.chrome.tabs.update(grant.tabId, { active: true })
    await state.chrome.windows.update(tab.windowId, { focused: true })
    return null
  }
  if (request.op === 'navigate') {
    const url = string(args.url)
    const origin = chromeOrigin(url)
    if (!origin || !grant.origins.includes(origin))
      throw new ChromeFault('originNotApproved', 'The navigation origin has not been approved.')
    await state.chrome.tabs.update(grant.tabId, { url })
    return tabState(state, grant.tabId)
  }
  if (request.op === 'history') {
    if (args.action === 'back') await state.chrome.tabs.goBack(grant.tabId)
    else if (args.action === 'forward') await state.chrome.tabs.goForward(grant.tabId)
    else if (args.action === 'reload') await state.chrome.tabs.reload(grant.tabId)
    else throw new ChromeFault('invalid', 'Invalid history action.')
    return tabState(state, grant.tabId)
  }
  if (request.op === 'command') {
    const method = string(args.method)
    if (!isAllowedCdp(method))
      throw new ChromeFault('invalid', `CDP method is not allowed: ${method}`)
    const before = await documentStamp(state, grant)
    const params = (args.params ?? {}) as Record<string, unknown>
    const dispatch = () => cdp(state, grant.tabId, method, params)
    const result =
      method === 'Page.captureScreenshot' || method === 'Accessibility.getFullAXTree'
        ? await withoutPointer(state, grant, dispatch)
        : await pointerCommand(state, grant, method, params, dispatch)
    await requireGrant(state, grant.leaseId)
    if (before !== (await documentStamp(state, grant)))
      throw new ChromeFault(
        'staleDocument',
        'The document changed during this operation. An action may have executed; do not retry it blindly. Claim the current document before observing it.',
      )
    return result
  }
  if (request.op === 'pointer') {
    if (typeof args.x !== 'number' || typeof args.y !== 'number')
      throw new ChromeFault('invalid', 'Invalid pointer coordinates.')
    await planPointer(state, grant, args.x, args.y)
    return null
  }
  throw new ChromeFault('invalid', 'Unknown Chrome operation.')
}
