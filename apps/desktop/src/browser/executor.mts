// litch_browser 命名空间的执行器：核心收到模型的 `item/tool/call`，经主进程交到这里。
// 这里管几件和具体工具无关的事：参数校验、挑标签（只许动这个会话里代理自己开的）、按来源审批（context.ask）、
// 把页面上攒下的提示和开着的对话框带进结果、回合结束时收拾。各个工具怎么做在 tools-*.mts。
// 不碰 Electron：页面由宿主（model.mts 的 BrowserHost）给，单元测试用假的宿主。
import { statSync } from 'node:fs'
import {
  type ClientToolCallResponse,
  type ClientToolContentItem,
  clientToolFailure,
} from '../../../../packages/protocol/src/client-tools.mjs'
import { BROWSER_NAMESPACE } from '../../../../packages/protocol/src/client-tools-browser.mjs'
import type {
  ClientToolContext,
  ClientToolDevice,
  ClientToolExecutor,
  ClientToolInvocation,
} from '../client-tools/types.mjs'
import { type Args, BadArgs, objectOf, str } from './args.mjs'
import { newRefBook, type RefBook } from './ax.mjs'
import { CdpRefused } from './cdp-allow.mjs'
import type { BrowserHost, BrowserPage, TabOwner } from './model.mjs'
import { type SiteBook, sessionKey } from './sites.mjs'
import { TOOLS } from './tools.mjs'
import { needsApproval, originOf } from './url.mjs'

/** 每个标签上执行器自己记的东西 */
export interface TabState {
  /** 快照里的编号 */
  book: RefBook
  /** 上一次快照的行，给 diff 用 */
  lastSnapshot: string[] | null
  /** 上一次截图里一个 CSS 像素合多少截图像素；还没截过是 1 */
  shotScale: number
  /** 上一次告诉模型的转发说明：同一句不再重复，换了（端口变了、ssh 报了问题）才再说 */
  forwardNote: string | null
}

/** 一次工具调用里各个工具能用的东西 */
export interface Call {
  invocation: ClientToolInvocation
  context: ClientToolContext
  args: Args
  owner: TabOwner
  host: BrowserHost
  /** 导航前改写网址的钩子（远端 localhost 转发用） */
  resolveUrl(url: string): Promise<string>
  /** 这个地址是远端 localhost 转发出来的话，给模型的一句说明；不是是 null */
  describeUrl(url: string): string | null
  /** 挑这次要动的标签：给了 tabId 用它（必须是这个会话里代理的），没给用当前的。都没有时抛错 */
  pick(): BrowserPage
  /** 同上，但没有标签时回 null */
  pickMaybe(): BrowserPage | null
  /** 当前标签换成它 */
  setCurrent(page: BrowserPage | null): void
  /** 这个会话现在的标签 */
  current(): BrowserPage | null
  state(page: BrowserPage): TabState
  /** 要访问这个地址行不行；不用问或者问了答应了回 null，不然回给模型的失败答复 */
  admit(url: string): Promise<ClientToolCallResponse | null>
  /** 页面现在的地址行不行（读、点之前查） */
  admitPage(page: BrowserPage): Promise<ClientToolCallResponse | null>
  /** 拼成功的答复：文字后面带上页面攒下的提示、开着的对话框 */
  done(page: BrowserPage | null, text: string, images?: string[]): ClientToolCallResponse
  /** 查一个本机文件（上传用） */
  statFile(path: string): { file: boolean; size: number } | null
  /** 交给人登录；没装（测试的宿主）是 null */
  handover: BrowserHandover | null
}

export type Tool = (call: Call) => Promise<ClientToolCallResponse>

/** 交给人登录（request_sign_in）的结果。failed：没能安全地重新载入，标签已关掉 */
export type SignInOutcome = 'done' | 'cancel' | 'closed' | 'aborted' | 'failed'

/**
 * 把代理的标签交给人登录（passwords/handover.mts 是真的那一份）。交出去的这段时间里，代理对这个标签的
 * 一切工具调用都被拒绝
 */
export interface BrowserHandover {
  /** 这个标签现在在不在人手里 */
  active(tabId: string): boolean
  /** tabs list、show 里要藏起来的标签：在人手里的，和交接期间网页开出来的弹窗 */
  hides(tabId: string): boolean
  /** 代理在这个标签当前的文档里执行过脚本（evaluate）：交给人之前要重新载入 */
  markScripted(tabId: string): void
  /** 交给人，等人交还或取消（signal 中止时回 aborted）。交还前清空各框架里密码框的值 */
  request(
    page: BrowserPage,
    ask: { site: string; reason: string },
    signal: AbortSignal,
  ): Promise<SignInOutcome>
}

/** 交给人登录的标签上，代理的调用一律回这一句 */
export const SIGNING_IN =
  'The user is signing in on this tab. Wait for `request_sign_in` to return before using it again.'

export interface BrowserExecutorOptions {
  host: BrowserHost
  sites: SiteBook
  /**
   * 导航之前改写网址：ssh 设备上的 localhost 经端口转发打开（browser/forwarding.mts）。不给就原样
   */
  resolveUrl?: (url: string, device: ClientToolDevice) => Promise<string> | string
  /** 转发出来的地址给模型的说明（每次答复里，页面在这种地址上时带一句）。不给就没有 */
  describeUrl?: (url: string, device: ClientToolDevice) => string | null
  statFile?: (path: string) => { file: boolean; size: number } | null
  handover?: BrowserHandover
}

/** 标签在人手里 */
class SigningIn extends Error {}

const defaultStat = (path: string) => {
  try {
    const stat = statSync(path)
    return { file: stat.isFile(), size: stat.size }
  } catch {
    return null
  }
}

export interface BrowserExecutor extends ClientToolExecutor {
  turnEnded(turn: { deviceId: string; threadId: string; turnId: string }): void
  /** 给测试和自检看：某个会话现在的标签 */
  currentTab(deviceId: string, threadId: string): string | null
}

export function createBrowserExecutor(options: BrowserExecutorOptions): BrowserExecutor {
  const { host, sites } = options
  const statFile = options.statFile ?? defaultStat
  const tabStates = new Map<string, TabState>()
  /** 会话 → 当前标签 */
  const currents = new Map<string, string>()
  /** 会话 → 正在进行的回合（导航闸门要按回合查“这一次”的允许） */
  const turns = new Map<string, string>()

  const ownerKey = (owner: TabOwner) => sessionKey(owner.deviceId, owner.threadId)
  const stateOf = (page: BrowserPage): TabState => {
    let state = tabStates.get(page.id)
    if (!state)
      tabStates.set(
        page.id,
        (state = { book: newRefBook(), lastSnapshot: null, shotScale: 1, forwardNote: null }),
      )
    return state
  }

  // 代理在用的标签上，网页自己跳去没审批过的来源一律拦下
  host.setNavigationGate((page, url) => {
    if (!needsApproval(url)) return true
    const origin = originOf(url)
    if (!origin) return false
    const session = ownerKey(page.info().owner)
    return sites.verdict(session, turns.get(session) ?? '', origin) === 'allow'
  })

  const declined = (origin: string) =>
    clientToolFailure(
      'declined',
      `The user declined access to ${origin}. Do not try to reach this site another way (other tabs, redirects, links, evaluate or other tools). Tell the user and ask how to proceed.`,
    )
  const blocked = (origin: string) =>
    clientToolFailure(
      'declined',
      `${origin} is on the user's blocklist in Litch's browser settings, so it cannot be opened. Do not try to reach this site another way (other tabs, redirects, links, evaluate or other tools). Tell the user and ask how to proceed.`,
    )

  async function call(
    invocation: ClientToolInvocation,
    context: ClientToolContext,
  ): Promise<ClientToolCallResponse> {
    if (invocation.namespace !== BROWSER_NAMESPACE) {
      return clientToolFailure('invalid', `unknown namespace ${String(invocation.namespace)}`)
    }
    const tool = TOOLS[invocation.tool]
    if (!tool) {
      return clientToolFailure(
        'invalid',
        `unknown tool ${invocation.tool}; available: ${Object.keys(TOOLS).join(', ')}`,
      )
    }
    const owner: TabOwner = { deviceId: invocation.device.id, threadId: invocation.threadId }
    const session = ownerKey(owner)
    turns.set(session, invocation.turnId)
    const used = new Set<BrowserPage>()

    const ensureAgent = (page: BrowserPage): BrowserPage => {
      const info = page.info()
      if (ownerKey(info.owner) !== session)
        throw new BadArgs(`no tab ${page.id} in this conversation`)
      if (info.kind !== 'agent') {
        throw new BadArgs(
          `tab ${page.id} belongs to the user; you can only operate tabs you opened. Open the same address with \`navigate\` (newTab: true) instead.`,
        )
      }
      if (options.handover?.active(page.id)) throw new SigningIn()
      if (!used.has(page)) {
        used.add(page)
        page.setAgentActive(true)
      }
      return page
    }

    const currentPage = (): BrowserPage | null => {
      const id = currents.get(session)
      const page = id ? host.page(id) : undefined
      if (page && ownerKey(page.info().owner) === session && page.info().kind === 'agent')
        return page
      // 当前的那个没了：退到这个会话最近开的代理标签
      const mine = host
        .pages()
        .filter((one) => ownerKey(one.info().owner) === session && one.info().kind === 'agent')
      const last = mine.at(-1) ?? null
      if (last) currents.set(session, last.id)
      else currents.delete(session)
      return last
    }

    const pickMaybe = (): BrowserPage | null => {
      const tabId = str(callArgs, 'tabId')
      if (tabId !== undefined) {
        const page = host.page(tabId)
        if (!page) throw new BadArgs(`no tab ${tabId}; call \`tabs\` with action "list"`)
        return ensureAgent(page)
      }
      const page = currentPage()
      return page ? ensureAgent(page) : null
    }

    const admit = async (url: string): Promise<ClientToolCallResponse | null> => {
      if (!needsApproval(url)) return null
      const origin = originOf(url)
      if (!origin) {
        return clientToolFailure(
          'invalid',
          `only http, https and about:blank can be opened: ${url}`,
        )
      }
      const verdict = sites.verdict(session, invocation.turnId, origin)
      if (verdict === 'allow') return null
      if (verdict === 'decline') return declined(origin)
      if (verdict === 'blocked') return blocked(origin)
      const answer = await context.ask({ kind: 'site', origin, url })
      switch (answer) {
        case 'once':
          sites.allowOnce(session, invocation.turnId, origin)
          return null
        case 'session':
          sites.allowSession(session, origin)
          return null
        case 'always':
          sites.allowAlways(origin)
          return null
        case 'decline':
          sites.decline(session, invocation.turnId, origin)
          return declined(origin)
        default:
          return clientToolFailure(
            'failed',
            `the approval for ${origin} was cancelled before the user answered`,
          )
      }
    }

    let callArgs: Args = {}
    const kit: Call = {
      invocation,
      context,
      args: callArgs,
      owner,
      host,
      resolveUrl: async (url) =>
        options.resolveUrl ? options.resolveUrl(url, invocation.device) : url,
      describeUrl: (url) => options.describeUrl?.(url, invocation.device) ?? null,
      pick() {
        const page = pickMaybe()
        if (!page) {
          throw new BadArgs(
            'this conversation has no browser tab yet; call `navigate` with a url first',
          )
        }
        return page
      },
      pickMaybe,
      setCurrent(page) {
        if (page) {
          ensureAgent(page)
          currents.set(session, page.id)
        } else currents.delete(session)
      },
      current: currentPage,
      state: stateOf,
      admit,
      admitPage: (page) => admit(page.info().url),
      done(page, text, images = []) {
        const lines = [text]
        if (page) {
          // 单独成段，免得接在快照最后一行后面像是网页上的字
          const forwarded = kit.describeUrl(page.info().url)
          const state = stateOf(page)
          if (forwarded && forwarded !== state.forwardNote) lines.push('', forwarded)
          state.forwardNote = forwarded
          const notices = page.takeNotices()
          if (notices.length > 0) lines.push('', 'Notices:', ...notices.map((one) => `- ${one}`))
          const dialog = page.dialog()
          if (dialog) {
            lines.push(
              '',
              `A ${dialog.type} dialog is open and blocks the page: ${JSON.stringify(dialog.message)}. Answer it with \`dialog\`.`,
            )
          }
        }
        const contentItems: ClientToolContentItem[] = [
          { type: 'inputText', text: lines.join('\n') },
        ]
        for (const imageUrl of images) contentItems.push({ type: 'inputImage', imageUrl })
        return { success: true, contentItems }
      },
      statFile,
      handover: options.handover ?? null,
    }

    try {
      callArgs = objectOf(invocation.arguments)
      kit.args = callArgs
      if (context.signal.aborted) return clientToolFailure('failed', 'the call was cancelled')
      // 回合被打断、连接断了：当场回失败，不等手上那一步（加载、等元素）自己做完
      const cancelled = new Promise<ClientToolCallResponse>((resolve) => {
        context.signal.addEventListener(
          'abort',
          () => resolve(clientToolFailure('failed', 'the call was cancelled')),
          { once: true },
        )
      })
      return await Promise.race([tool(kit), cancelled])
    } catch (error) {
      if (error instanceof SigningIn) return clientToolFailure('failed', SIGNING_IN)
      if (error instanceof BadArgs) return clientToolFailure('invalid', error.message)
      if (error instanceof CdpRefused) return clientToolFailure('failed', error.message)
      if (context.signal.aborted) return clientToolFailure('failed', 'the call was cancelled')
      return clientToolFailure('failed', error instanceof Error ? error.message : String(error))
    }
  }

  function turnEnded(turn: { deviceId: string; threadId: string; turnId: string }): void {
    const session = sessionKey(turn.deviceId, turn.threadId)
    for (const page of host.pages()) {
      const info = page.info()
      if (ownerKey(info.owner) !== session) continue
      if (info.kind === 'agent' && !info.keep) {
        host.close(page.id)
        tabStates.delete(page.id)
      } else host.release(page.id)
    }
    sites.turnEnded(session, turn.turnId)
    if (turns.get(session) === turn.turnId) turns.delete(session)
    const current = currents.get(session)
    if (current && !host.page(current)) currents.delete(session)
  }

  return {
    namespace: BROWSER_NAMESPACE,
    call,
    turnEnded,
    currentTab: (deviceId, threadId) => currents.get(sessionKey(deviceId, threadId)) ?? null,
  }
}
