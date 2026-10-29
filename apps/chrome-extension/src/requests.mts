import type { ChromeGrant, ChromeRequest } from '../../../packages/protocol/src/chrome-browser.mjs'
import { isAllowedCdp } from '../../desktop/src/browser/cdp-allow.mjs'
import { chromeOrigin } from './origin.mjs'
import {
  attach,
  ChromeFault,
  cdp,
  documentStamp,
  type ExtensionState,
  inspectOrigins,
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
  if (request.op === 'list') {
    const tabs = await state.chrome.tabs.query({})
    return Promise.all(
      tabs
        .filter((tab: any) => !tab.incognito && chromeOrigin(tab.pendingUrl || tab.url || ''))
        .map(async (tab: any) => ({
          ...(await tabState(state, tab.id)),
          origins: await inspectOrigins(state, tab.id).catch(() => []),
          busy: [...state.grants.values()].some((grant) => grant.tabId === tab.id),
        })),
    )
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
    if (existing) throw new ChromeFault('busy', 'This Chrome tab is already claimed.')
    const tab = await tabState(state, grant.tabId)
    if (tab.url !== args.expectedUrl || tab.generation !== args.expectedGeneration)
      throw new ChromeFault('staleDocument', 'The selected tab changed. List tabs again.')
    // 同步占位，两个并行会话不能同时越过空闲检查。
    state.grants.set(grant.leaseId, grant)
    try {
      await documentStamp(state, grant)
      await attach(state, grant.tabId)
      await documentStamp(state, grant)
      grant.expiresAt = Date.now() + 15_000
      state.grants.set(grant.leaseId, grant)
      await saveAttached(state)
      await cdp(state, grant.tabId, 'Page.enable')
      await cdp(state, grant.tabId, 'Runtime.enable')
      return { tab: await tabState(state, grant.tabId), leaseId: grant.leaseId }
    } catch (error) {
      state.grants.delete(grant.leaseId)
      await state.chrome.debugger.detach({ tabId: grant.tabId }).catch(() => {})
      throw error
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
    state.console.delete(grant.tabId)
    state.paused.add(grant.leaseId)
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
    const result = await cdp(state, grant.tabId, method, args.params ?? {})
    await requireGrant(state, grant.leaseId)
    if (before !== (await documentStamp(state, grant)))
      throw new ChromeFault(
        'staleDocument',
        'The document changed during this operation. An action may have executed; do not retry it blindly. Claim the current document before observing it.',
      )
    return result
  }
  if (request.op === 'pointer') return null // 公共光标 host 的 isolated-world 适配接入点。
  throw new ChromeFault('invalid', 'Unknown Chrome operation.')
}
