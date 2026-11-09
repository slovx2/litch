// 桌面与手机之间转发自身访问批准和网站待处理状态；旧代理代填卡片不再发布或显示。
import {
  APPROVAL_ANSWER,
  APPROVAL_ANSWERED,
  APPROVAL_CHANGED,
  APPROVAL_CLOSE,
  APPROVAL_ERROR,
  APPROVAL_LIST,
  APPROVAL_OPEN,
  type ApprovalAnswer,
  type ApprovalCard,
  type ApprovalCardView,
  type ApprovalChangedNotification,
  isApprovalAnswer,
  isApprovalToken,
} from '../../../protocol/src/client-approvals.mjs'
import type { ClientRequestMethod, ClientRequests } from '../../../protocol/src/index.mjs'
import { type ApprovalsOp, ChannelError } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { RpcError } from '../connection/rpc.mjs'
import type { ApprovalsTopicView } from '../model-approvals.mjs'
import type { ToolAskPlace } from './tool-calls.mjs'

export interface ApprovalsHost {
  deviceId: string
  online(): boolean
  /** 对面是设备服务，而且设备信息的 extensions 里列了 clientApprovals */
  supported(): boolean
  /** 卡片上写的“会话所在设备”：桌面端给这台设备起的名字 */
  deviceName(): string
  request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequests[M]['params'],
  ): Promise<ClientRequests[M]['result']>
  /** 手机的答复交给主进程验（ToolHub.phoneAnswer；主进程按答复里的卡片号找卡片）。没有外壳（手机、测试）时不给 */
  phoneAnswer?(answer: ApprovalAnswer): void
  /** 请求没做成：换成给人看的错误 */
  fail(error: unknown): ChannelError
  log(line: string): void
}

export interface Approvals {
  /**
   * 对话里出了一张客户端工具的卡片：是带桌面端号的登录卡片就挂到设备上，回“收掉”的函数；别的卡片回 null。
   * 卡片答了、撤了都要调一次收掉
   */
  ask(place: ToolAskPlace): (() => void) | null
  /** 订阅（手机）。先给快照，之后给增量；返回退订函数 */
  open(sink: HostSink): () => void
  /** 手机答一张卡片：签好名的答复原样交给设备 */
  answer(answer: ApprovalAnswer): Promise<void>
  /** 是这项扩展的通知就处理掉并返回 true */
  notification(method: string, params: unknown): boolean
  /** 连上并认出对面是谁了 */
  resync(): void
  /** 连接断了 */
  offline(): void
}

/**
 * 从对话里那张登录卡片（ClientAskView 的 signIn）拼出发到设备的卡片。只取给人看的、打码的东西：
 * 账号只给 ref 和打码的用户名。卡片号、随机数用登录卡片自己的 id、nonce，桌面端号是主进程带上的 desktopId
 * （apps/desktop/src/approvals/verify.mts 的 approvalDesktopId，主进程没装好验签时是 null）。
 * 不是登录卡片、没带桌面端号、形状不对都是 null（不发到手机）
 */
export function phoneCardOf(place: ToolAskPlace, device: string): ApprovalCard | null {
  const ask = place.ask as unknown as Record<string, unknown>
  if (ask.kind !== 'computerSelf') return null
  if (!isApprovalToken(ask.id) || !isApprovalToken(ask.nonce) || !isApprovalToken(ask.desktopId))
    return null
  return {
    id: ask.id,
    nonce: ask.nonce,
    desktopId: ask.desktopId,
    threadId: place.threadId,
    kind: 'computerSelf',
    summary: { origin: 'litch://computer-self', device },
    expiresAt: null,
  }
}

export function createApprovals(host: ApprovalsHost): Approvals {
  const { deviceId } = host
  // 站点卡只发布等待状态，不作为授权凭据；设备或手机无法据此批准操作。
  const sitePrefix = `site-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
  let siteSequence = 0
  /** 这台桌面端挂出去的：卡片号 → 对话里那张卡片的标识 */
  const outgoing = new Map<string, string>()
  const readOnly = new Set<string>()
  const sinks = new Set<HostSink>()
  /** 手机看到的：会话 → 挂着的卡片。null：还没取到 */
  let cards: Map<string, ApprovalCardView[]> | null = null
  /** 每次断开、重新认对面时换一个代号，在途的结果回来时对不上就作废 */
  let epoch = 0

  const view = (): ApprovalsTopicView => ({
    deviceId,
    available: host.online() ? host.supported() : null,
    cards: cards ? [...cards.values()].flat().sort((a, b) => a.openedAt - b.openedAt) : [],
  })

  const publishAll = () => {
    if (sinks.size === 0) return
    const ops: ApprovalsOp[] = [{ op: 'approvals.set', view: view() }]
    for (const sink of sinks) sink.delta(ops)
  }

  const load = () => {
    if (sinks.size === 0 || !host.online() || !host.supported()) return
    const mine = epoch
    host.request(APPROVAL_LIST, {}).then(
      (listed) => {
        if (mine !== epoch) return
        const next = new Map<string, ApprovalCardView[]>()
        for (const card of listed.data.filter((card) => card.kind !== 'browserSignIn'))
          next.set(card.threadId, [...(next.get(card.threadId) ?? []), card])
        cards = next
        publishAll()
      },
      (error: unknown) => host.log(`取挂着的批准卡片失败：${String(error)}`),
    )
  }

  return {
    ask(place) {
      if (!host.online() || !host.supported()) return null
      const card: ApprovalCard | null =
        place.ask.kind === 'site'
          ? {
              id: `${sitePrefix}-${++siteSequence}`,
              threadId: place.threadId,
              desktopId: sitePrefix,
              nonce: sitePrefix,
              expiresAt: null,
              kind: 'browserSite',
              summary: {
                origin: place.ask.origin,
                device: host.deviceName(),
                browser: place.ask.browser ?? 'builtin',
              },
            }
          : phoneCardOf(place, host.deviceName())
      if (!card) return null
      outgoing.set(card.id, place.askId)
      if (card.kind === 'browserSite') readOnly.add(card.id)
      const mine = epoch
      host.request(APPROVAL_OPEN, card).catch((error: unknown) => {
        if (mine === epoch) host.log(`批准卡片 ${card.id} 挂不到设备上：${String(error)}`)
      })
      let closed = false
      return () => {
        if (closed) return
        closed = true
        if (outgoing.get(card.id) !== place.askId) return
        outgoing.delete(card.id)
        readOnly.delete(card.id)
        if (mine !== epoch || !host.online()) return
        host.request(APPROVAL_CLOSE, { id: card.id }).catch((error: unknown) => {
          host.log(`收掉批准卡片 ${card.id} 失败：${String(error)}`)
        })
      }
    },

    open(sink) {
      sinks.add(sink)
      sink.snapshot(view())
      if (cards === null) load()
      return () => {
        sinks.delete(sink)
        // 没人看了就不跟着记：下次打开重新取
        if (sinks.size === 0) cards = null
      }
    },

    async answer(answer) {
      try {
        await host.request(APPROVAL_ANSWER, answer)
      } catch (error) {
        // 卡片已经收掉（答过了、撤了、过期了）：手机按 notFound 认出来，说“卡片已收掉”
        if (
          error instanceof RpcError &&
          (error.data as { reason?: unknown } | undefined)?.reason ===
            APPROVAL_ERROR.unknownApproval
        )
          throw new ChannelError('notFound', `批准卡片已收掉：${answer.id}`)
        throw host.fail(error)
      }
    },

    notification(method, params) {
      if (method === APPROVAL_ANSWERED) {
        // 原样交给主进程验签；不是这台桌面端挂的（或者已经收掉了）不理
        if (!isApprovalAnswer(params)) return true
        if (outgoing.has(params.id) && !readOnly.has(params.id)) host.phoneAnswer?.(params)
        return true
      }
      if (method === APPROVAL_CHANGED) {
        if (cards === null) return true
        const changed = params as ApprovalChangedNotification
        if (typeof changed?.threadId !== 'string' || !Array.isArray(changed.data)) return true
        if (changed.data.length === 0) cards.delete(changed.threadId)
        else
          cards.set(
            changed.threadId,
            changed.data.filter((card) => card.kind !== 'browserSignIn'),
          )
        publishAll()
        return true
      }
      return false
    },

    resync() {
      epoch++
      cards = null
      publishAll()
      load()
    },

    offline() {
      epoch++
      // 设备那边随连接一起收掉了
      outgoing.clear()
      readOnly.clear()
      cards = null
      publishAll()
    },
  }
}
