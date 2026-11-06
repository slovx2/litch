import type { ChromeGrant, ChromeRequest } from '../../../packages/protocol/src/chrome-browser.mjs'
import { isAllowedCdp } from '../../desktop/src/browser/cdp-allow.mjs'
import { isInputCommand } from '../../desktop/src/browser/input-command.mjs'
import { createBackgroundTab } from './background-tab.mjs'
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
  const grant = request.leaseId ? state.grants.get(request.leaseId) : undefined
  const visible =
    grant && ['command', 'pointer', 'navigate', 'history', 'show', 'console'].includes(request.op)
  if (!visible) return executeRequest(state, request)
  if (request.epoch !== state.epoch) throw new ChromeFault('staleLease', 'Chrome reconnected.')
  await requireGrant(state, grant.leaseId, request.generation)
  try {
    await state.presentation.active(grant.tabId, grant.leaseId, true)
    return await executeRequest(state, request)
  } finally {
    await state.presentation.active(grant.tabId, grant.leaseId, false).catch(() => {})
  }
}

async function executeRequest(state: ExtensionState, request: ChromeRequest): Promise<unknown> {
  if (state.stopped && !['release', 'stop'].includes(request.op))
    throw new ChromeFault(
      'userStopped',
      'The user stopped Chrome control. Ask the user to click the Litch extension to resume control.',
    )
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
    const tab = await createBackgroundTab(state.chrome)
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
      // 后台/最小化窗口没有可绘制的焦点；只模拟已租用标签，不激活浏览器窗口。
      await cdp(state, grant.tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true })
      const current = await tabState(state, grant.tabId)
      await requireGrant(state, grant.leaseId, args.expectedGeneration as number)
      await state.presentation.claim(grant)
      await requireGrant(state, grant.leaseId, args.expectedGeneration as number)
      return { tab: current, leaseId: grant.leaseId }
    } catch (error) {
      state.grants.delete(grant.leaseId)
      await state.presentation.release(grant.tabId, grant.leaseId).catch(() => {})
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
    await state.presentation.keep(grant.tabId, grant.leaseId, grant.original || grant.keep)
    return null
  }
  if (request.op === 'freeze') {
    await requireGrant(state, grant.leaseId, request.generation)
    if (state.paused.size)
      throw new ChromeFault('signingIn', 'Chrome is already paused for sign-in.')
    state.paused.add(grant.leaseId)
    await cdp(state, grant.tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false })
    state.console.clear()
    await disposePointer(state, grant)
    // 登录卡尚未被用户处理：只暂停控制，不擅自切换用户窗口或标签。
    return null
  }
  if (request.op === 'unfreeze') {
    // 人交还后重新载入，清掉本轮表单输入与旧上下文；随后桌面释放租约并要求重新 claim。
    await state.chrome.tabs.reload(grant.tabId)
    return tabState(state, grant.tabId)
  }
  await requireGrant(state, grant.leaseId, request.generation)
  if (request.op === 'refresh') return tabState(state, grant.tabId)
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
    if (args.inputReceipt === true && isInputCommand(method, params)) {
      // CDP 已确认派发后才进入此分支；正常导航不再伪装成派发前过期。
      // 只回标签元数据，绝不把越过来源边界后的页面内容夹带回去。
      let documentChanged = false
      try {
        await requireGrant(state, grant.leaseId)
        documentChanged = before !== (await documentStamp(state, grant))
      } catch (error) {
        if (
          !(error instanceof ChromeFault) ||
          !['staleDocument', 'originNotApproved'].includes(error.code)
        )
          throw error
        documentChanged = true
      }
      return {
        inputReceipt: true,
        value: result,
        documentChanged,
        tab: await tabState(state, grant.tabId),
      }
    }
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
