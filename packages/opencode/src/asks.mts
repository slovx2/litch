import { approve } from './approvals.mjs'
import { ask } from './questions.mjs'
import type { LiveThread, OpencodeServer } from './server.mjs'

// OpenCode 来要用户拿主意的两种请求：权限（permission.asked）和提问（question.asked）。
// 都按会话找到打开着的线程，转给它的订阅连接，答复交回 OpenCode。
// 子代理（task 工具）跑在 OpenCode 的子会话里，子会话不是适配器打开的线程：顺着 parentID 找到打开着的上级会话，
// 归到它名下问（条目找不到，审批卡片挂在请求号上）。都找不到的不管：那是别的客户端打开的会话，留给它。
// OpenCode 的这两种请求状态按目录实例分，回复要带事件所在的目录（directory）。

interface Pending {
  threadId: string
  controller: AbortController
}

export class Asks {
  private readonly server: OpencodeServer
  // 正在等用户的请求：OpenCode 的请求号 → 撤回用的控制器
  private readonly pending = new Map<string, Pending>()
  // 会话 → 上级会话（问过 OpenCode 的；没有上级的是 null）
  private readonly parents = new Map<string, string | null>()

  constructor(server: OpencodeServer) {
    this.server = server
  }

  // 这个会话归哪个打开着的线程：它自己，或者它的上级（子代理）
  private async owner(sessionID: string, directory: string | null): Promise<LiveThread | null> {
    let id: string | null = sessionID
    for (let depth = 0; id && depth < 8; depth += 1) {
      const live = this.server.live.get(id)
      if (live) return live
      if (!this.parents.has(id)) {
        const api = await this.server.api()
        const info = await api
          .request('GET', `/session/${id}`, { directory, timeoutMs: 5000 })
          .catch(() => null)
        this.parents.set(id, typeof info?.parentID === 'string' ? info.parentID : null)
      }
      id = this.parents.get(id) ?? null
    }
    return null
  }

  private track(id: string, threadId: string): AbortController | null {
    if (this.pending.has(id)) return null
    const controller = new AbortController()
    this.pending.set(id, { threadId, controller })
    return controller
  }

  async permission(directory: string | null, request: any): Promise<void> {
    const id = String(request?.id ?? '')
    const live = id ? await this.owner(String(request.sessionID), directory) : null
    if (!live) return
    const controller = this.track(id, live.projection.thread.id)
    if (!controller) return
    const reply = async (body: unknown) => {
      const api = await this.server.api()
      await api
        .request('POST', `/permission/${id}/reply`, {
          directory: directory ?? live.directory,
          body,
        })
        .catch(() => {})
    }
    try {
      // 完全访问：OpenCode 设成“要问”的一律直接允许这一次，不来问用户（设成“禁止”的它自己就拒了，不会来问）
      if ((live.turnPreset ?? live.settings.preset) === ':danger-full-access') {
        await reply({ reply: 'once' })
        return
      }
      const answer = await approve(this.server, live, request, controller.signal)
      // 别处已经答了（OpenCode 连带拒掉的、别的客户端答的）：不再交回
      if (controller.signal.aborted) return
      await reply({ reply: answer.reply, ...(answer.message ? { message: answer.message } : {}) })
      if (answer.interrupt) void this.server.turns.interrupt(live.projection.thread.id)
    } finally {
      this.pending.delete(id)
    }
  }

  async question(directory: string | null, request: any): Promise<void> {
    const id = String(request?.id ?? '')
    const live = id ? await this.owner(String(request.sessionID), directory) : null
    if (!live) return
    const controller = this.track(id, live.projection.thread.id)
    if (!controller) return
    try {
      const answers = await ask(this.server, live, request, controller.signal)
      if (controller.signal.aborted) return
      const api = await this.server.api()
      const target = directory ?? live.directory
      // 问不成的拒掉：模型拿到“用户没有回答”，回合接着走（回合被打断的，OpenCode 那边已经停了，拒掉只是收拾）
      await (answers
        ? api.request('POST', `/question/${id}/reply`, {
            directory: target,
            body: { answers },
          })
        : api.request('POST', `/question/${id}/reject`, { directory: target })
      ).catch(() => {})
    } finally {
      this.pending.delete(id)
    }
  }

  /** OpenCode 说这个请求已经有结果了（permission.replied 等）：还在问用户的撤回 */
  answered(requestID: string): void {
    this.pending.get(requestID)?.controller.abort()
  }

  /**
   * 会话打开之前就在等的请求补问一遍（适配器重启、事件流断开期间来的、别处发起的回合里的）。
   * 只问这个会话自己的；子会话的等它们再来事件。
   */
  async resume(live: LiveThread): Promise<void> {
    const api = this.server.runtime.current()
    if (!api) return
    const id = live.projection.thread.id
    const options = { directory: live.directory, timeoutMs: 5000 }
    const [permissions, questions] = await Promise.all([
      api.request<any[]>('GET', '/permission', options).catch(() => []),
      api.request<any[]>('GET', '/question', options).catch(() => []),
    ])
    for (const request of Array.isArray(permissions) ? permissions : [])
      if (request?.sessionID === id) void this.permission(live.directory, request)
    for (const request of Array.isArray(questions) ? questions : [])
      if (request?.sessionID === id) void this.question(live.directory, request)
  }

  /**
   * 打断之后：OpenCode 的 abort 不清挂起的权限请求（实测 3 秒后还在 GET /permission 里），
   * 这个会话还挂着的权限请求和提问一律拒掉，在问用户的撤回（serverRequest/resolved 由撤回发出）。
   */
  async clear(live: LiveThread): Promise<void> {
    const id = live.projection.thread.id
    for (const [requestId, entry] of this.pending)
      if (entry.threadId === id) {
        entry.controller.abort()
        this.pending.delete(requestId)
      }
    const api = this.server.runtime.current()
    if (!api) return
    const options = { directory: live.directory, timeoutMs: 5000 }
    const [permissions, questions] = await Promise.all([
      api.request<any[]>('GET', '/permission', options).catch(() => []),
      api.request<any[]>('GET', '/question', options).catch(() => []),
    ])
    await Promise.all([
      ...(Array.isArray(permissions) ? permissions : [])
        .filter((request) => request?.sessionID === id)
        .map((request) =>
          api
            .request('POST', `/permission/${request.id}/reply`, {
              ...options,
              body: { reply: 'reject' },
            })
            .catch(() => {}),
        ),
      ...(Array.isArray(questions) ? questions : [])
        .filter((request) => request?.sessionID === id)
        .map((request) =>
          api.request('POST', `/question/${request.id}/reject`, options).catch(() => {}),
        ),
    ])
  }
}
