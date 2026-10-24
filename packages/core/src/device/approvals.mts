// 一台设备上的手机批准（协议扩展 clientApprovals）在客户端这一头：桌面端和手机两头的转运都在这里，验签不在这里。
//
// 桌面端（有外壳、执行内置浏览器的那一台）：执行器在会话的对话里出登录卡片时（kind 为 signIn、带着主进程的桌面端号 desktopId），
// 把给人看的摘要（打码的用户名，没有明文）经会话所在的这台设备挂上去（litch/approval/open）；卡片答了、撤了就收掉
// （litch/approval/close）。设备转来手机的答复（litch/approval/answered）原样交给主进程，主进程自己验签
// （apps/desktop/src/approvals/verify.mts），验过了才算数、卡片两处一起收。
//
// 手机：订阅 approvals 主题（会话页开着时）拿这台设备上现在挂着的卡片（litch/approval/list，之后跟着 litch/approval/changed），
// 答复由移动端的外壳签好名交过来（approval.answer），这里只转给设备。
//
// 连接断了设备那边就收掉这条连接挂的卡片；执行中的工具调用也会被取消（tool-calls.mts 的 offline），所以断线后不重挂。
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
  isApprovalRef,
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
  if (ask.kind !== 'signIn') return null
  if (!isApprovalToken(ask.id) || !isApprovalToken(ask.nonce) || !isApprovalToken(ask.desktopId))
    return null
  if (typeof ask.origin !== 'string' || !ask.origin) return null
  const accounts: ApprovalCard['summary']['accounts'] = []
  for (const account of Array.isArray(ask.accounts) ? ask.accounts : []) {
    const { ref, masked } = (account ?? {}) as { ref?: unknown; masked?: unknown }
    if (!isApprovalRef(ref) || typeof masked !== 'string') return null
    accounts.push({ ref, masked })
  }
  const task = ask.task as { id?: unknown; name?: unknown } | null | undefined
  const taskId = typeof task?.id === 'string' ? task.id : ask.taskId
  return {
    id: ask.id,
    threadId: place.threadId,
    kind: 'browserSignIn',
    summary: {
      origin: ask.origin,
      site: typeof ask.site === 'string' ? ask.site : '',
      reason: typeof ask.reason === 'string' ? ask.reason : '',
      device,
      accounts,
      task:
        typeof taskId === 'string' && taskId
          ? { id: taskId, name: typeof task?.name === 'string' ? task.name : '' }
          : null,
      fillBlocked: typeof ask.fillBlocked === 'string' ? ask.fillBlocked : null,
    },
    desktopId: ask.desktopId,
    nonce: ask.nonce,
    expiresAt: typeof ask.expiresAt === 'number' ? ask.expiresAt : null,
  }
}

export function createApprovals(host: ApprovalsHost): Approvals {
  const { deviceId } = host
  /** 这台桌面端挂出去的：卡片号 → 对话里那张卡片的标识 */
  const outgoing = new Map<string, string>()
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
        for (const card of listed.data)
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
      const card = phoneCardOf(place, host.deviceName())
      if (!card) return null
      outgoing.set(card.id, place.askId)
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
        if (outgoing.has(params.id)) host.phoneAnswer?.(params)
        return true
      }
      if (method === APPROVAL_CHANGED) {
        if (cards === null) return true
        const changed = params as ApprovalChangedNotification
        if (typeof changed?.threadId !== 'string' || !Array.isArray(changed.data)) return true
        if (changed.data.length === 0) cards.delete(changed.threadId)
        else cards.set(changed.threadId, changed.data)
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
      cards = null
      publishAll()
    },
  }
}
