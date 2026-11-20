// 标签和导航：tabs、navigate、show。
import { clientToolFailure } from '../tool-port.mjs'
import { BadArgs, bool, oneOf, str } from './args.mjs'
import { type Call, SIGNING_IN, type Tool } from './executor.mjs'
import type { BrowserPage } from './model.mjs'
import { pageLine } from './page-ops.mjs'
import { sessionKey } from './sites.mjs'
import { snapshot } from './tools-read.mjs'
import { BLANK, isLocalHost, isOpenable, parseUrl, toAddress } from './url.mjs'

/** 等页面加载的上限 */
const LOAD_MS = 30_000

const sameSession = (call: Call, page: BrowserPage) => {
  const owner = page.info().owner
  return (
    sessionKey(owner.deviceId, owner.threadId) ===
    sessionKey(call.owner.deviceId, call.owner.threadId)
  )
}

/**
 * 远程设备上的会话打开 localhost，而这个地址没有经 ssh 转发（没接转发的执行器，比如单元测试）：
 * 打开的是这台桌面的 localhost，提醒模型。转发出来的地址由 done 带上说明
 */
function remoteNote(call: Call, url: string): string | null {
  const parsed = parseUrl(url)
  if (call.invocation.device.kind !== 'ssh' || !parsed || !isLocalHost(parsed.hostname)) return null
  if (call.describeUrl(url)) return null
  return `Note: this conversation runs on the remote device "${call.invocation.device.name}", but the browser runs on the user's desktop, so ${parsed.host} here is the desktop's, not the remote machine's.`
}

/** 把一段地址变成能开的网址，并过一遍改写钩子和审批。不行时回失败答复 */
async function resolve(call: Call, raw: string) {
  const address = toAddress(raw, false)
  if (!address) throw new BadArgs(`not a valid address: ${JSON.stringify(raw)}`)
  if (!isOpenable(address)) {
    const hint = address.startsWith('file:')
      ? ' To show a local file, serve its folder over HTTP (for example `python3 -m http.server`) and open http://localhost:PORT/.'
      : ''
    return {
      refusal: clientToolFailure(
        'invalid',
        `only http, https and about:blank can be opened.${hint}`,
      ),
    }
  }
  const url = await call.resolveUrl(address)
  const refusal = await call.admit(url)
  return refusal ? { refusal } : { url }
}

async function loadInto(call: Call, page: BrowserPage, url: string) {
  const outcome = await page.load(url, LOAD_MS)
  const lines = [
    outcome.ok ? 'Loaded.' : `The page did not load: ${outcome.error ?? 'unknown error'}`,
  ]
  lines.push(pageLine(page))
  const note = remoteNote(call, url)
  if (note) lines.push(note)
  return { ...call.done(page, lines.join('\n')), success: outcome.ok }
}

export const tabs: Tool = async (call) => {
  const action = oneOf(
    call.args,
    'action',
    ['list', 'new', 'select', 'close', 'keep'] as const,
    true,
  )
  if (action === 'list') {
    const current = call.current()
    const list = call.host
      .pages()
      .filter((page) => page.info().kind === 'user' || sameSession(call, page))
      .map((page) => {
        const info = page.info()
        // 人正在登录的标签、交接期间开出来的弹窗：只给占位，不给地址和标题
        if (call.handover?.hides(info.id)) {
          return {
            tabId: info.id,
            owner: info.kind === 'agent' ? 'you' : 'user',
            current: page === current,
            signingIn: true,
            note: 'The user is signing in here; its address and title are hidden until request_sign_in returns.',
          }
        }
        return {
          tabId: info.id,
          owner: info.kind === 'agent' ? 'you' : 'user',
          current: page === current,
          keep: info.keep,
          title: info.title,
          url: info.url,
          loading: info.loading,
          ...(info.kind === 'user' && call.userTabs
            ? {
                claimToken: call.userTabs.token(page),
                claimed: call.userTabs.owns(page),
                busy: info.agentActive && !call.userTabs.owns(page),
              }
            : {}),
        }
      })
    return call.done(
      null,
      list.length === 0 ? 'No tabs yet.' : JSON.stringify({ tabs: list }, null, 1),
    )
  }
  if (action === 'close' || action === 'keep') {
    const id = str(call.args, 'tabId')
    const page = id ? call.host.page(id) : call.current()
    if (page?.info().kind === 'user')
      throw new BadArgs(
        'User tabs are never closed or made temporary by the agent. Call release(tabId) to return control.',
      )
  }
  if (action === 'new') {
    const raw = str(call.args, 'url')
    let url = BLANK
    if (raw !== undefined && raw.trim() !== '') {
      const resolved = await resolve(call, raw)
      if ('refusal' in resolved) return resolved.refusal
      url = resolved.url
    }
    const page = call.host.open(call.owner, 'agent', { keep: bool(call.args, 'keep') === true })
    call.setCurrent(page)
    if (url === BLANK) return call.done(page, `Opened ${pageLine(page)}`)
    return loadInto(call, page, url)
  }
  const page = call.pick()
  if (action === 'select') {
    call.setCurrent(page)
    return call.done(page, `Current tab is now ${pageLine(page)}`)
  }
  if (action === 'keep') {
    const keep = bool(call.args, 'keep') ?? true
    call.host.setKeep(page.id, keep)
    return call.done(
      page,
      keep
        ? `Tab ${page.id} will stay open for the user.`
        : `Tab ${page.id} will close at the end of the turn.`,
    )
  }
  call.host.close(page.id)
  call.setCurrent(null)
  return call.done(null, `Closed tab ${page.id}.`)
}

export const navigate: Tool = async (call) => {
  const action = oneOf(call.args, 'action', ['back', 'forward', 'reload'] as const)
  const raw = str(call.args, 'url')
  if (action) {
    const page = call.pick()
    const outcome = await page.history(action, LOAD_MS)
    const lines = [outcome.ok ? 'Done.' : `Did not finish: ${outcome.error ?? 'unknown error'}`]
    lines.push(pageLine(page))
    return { ...call.done(page, lines.join('\n')), success: outcome.ok }
  }
  if (raw === undefined) throw new BadArgs('give `url`, or `action` (back, forward, reload)')
  const resolved = await resolve(call, raw)
  if ('refusal' in resolved) return resolved.refusal
  const fresh = bool(call.args, 'newTab') === true
  let page = fresh ? null : call.pickMaybe()
  if (!page) {
    page = call.host.open(call.owner, 'agent', { keep: bool(call.args, 'keep') === true })
  }
  call.setCurrent(page)
  return loadInto(call, page, resolved.url)
}

export const show: Tool = async (call) => {
  const tabId = str(call.args, 'tabId')
  let page: BrowserPage | null | undefined
  if (tabId !== undefined) {
    // 用户自己的标签也可以拿出来给用户看
    page = call.host.page(tabId)
    if (!page || (page.info().kind !== 'user' && !sameSession(call, page)))
      throw new BadArgs(`no tab ${tabId} in this conversation`)
    if (call.handover?.hides(page.id)) return clientToolFailure('failed', SIGNING_IN)
  } else page = call.pickMaybe()
  if (!page) throw new BadArgs('no tab to show; call `navigate` first')
  call.host.show(page.id)
  // 显示不等于站点授权；未认领用户页只能回标题/地址，不能附带网页对话框或通知。
  return call.done(
    page.info().kind === 'user' && !call.userTabs?.owns(page) ? null : page,
    `Showing ${pageLine(page)} in the Litch browser panel.`,
  )
}

/** 只做站点审批，没有标签级或实例级审批；成功返回全新观察，不复用上次租约引用。 */
export const claim: Tool = async (call) => {
  if (!call.userTabs) throw new BadArgs('User tab claiming is unavailable in this host.')
  const token = str(call.args, 'claimToken', true)
  const page = call.userTabs.take(token)
  const refusal = await call.userTabs.claim(page)
  if (refusal) return refusal
  try {
    call.setCurrent(page)
    call.args = { tabId: page.id }
    const result = await snapshot(call)
    if (!result.success) call.userTabs.release(page)
    return result
  } catch (error) {
    call.userTabs.release(page)
    throw error
  }
}

export const ensureClaimed: Tool = async (call) => {
  const id = str(call.args, 'tabId', true)
  const page = call.host.page(id)
  if (!page) throw new BadArgs('The tab was closed. List tabs and choose the intended tab again.')
  if (!call.userTabs) throw new BadArgs('User tab claiming is unavailable in this host.')
  const refusal = await call.userTabs.claim(page)
  if (refusal) return refusal
  try {
    call.setCurrent(page)
    await page.waitForLoad(LOAD_MS, call.context.signal)
    const result = await snapshot(call)
    if (!result.success && page.info().kind === 'user') call.userTabs.release(page)
    return result
  } catch (error) {
    if (page.info().kind === 'user') call.userTabs.release(page)
    throw error
  }
}

export const release: Tool = async (call) => {
  const id = str(call.args, 'tabId', true)
  const page = call.host.page(id)
  if (!page) return call.done(null, 'The tab was already closed by the user.')
  if (!call.userTabs) throw new BadArgs('User tab claiming is unavailable in this host.')
  call.userTabs.release(page)
  return call.done(null, `Released user tab ${id}; it remains open.`)
}
