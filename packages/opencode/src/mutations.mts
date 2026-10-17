import {
  historyHeadCursors,
  ProtocolError,
  requiredString,
} from '../../shared/src/protocol-contract.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { splitModel } from './catalog.mjs'
import { envelope, settings } from './envelope.mjs'
import type { LiveThread, OpencodeServer } from './server.mjs'

// 改动会话本身的几个方法：分叉、回退、删除、压缩、用户自己跑命令。都要求会话没有进行中的回合。

const busy = () => new ProtocolError(-32009, '活动会话不能执行此操作')

export async function threadMutation(
  s: OpencodeServer,
  peer: RpcPeer,
  method: string,
  p: any,
): Promise<any> {
  if (method === 'thread/fork' && p.lastTurnId != null && p.beforeTurnId != null)
    throw new ProtocolError(-32602, 'beforeTurnId 不能与 lastTurnId 同时使用')
  const live = await s.load(requiredString(p.threadId, 'threadId'))
  const { projection } = live
  if (method === 'thread/fork' && p.lastTurnId != null && p.lastTurnId === projection.active?.id)
    throw new ProtocolError(-32602, 'lastTurnId 所指回合仍在进行中')
  if (projection.active) throw busy()
  if (method === 'thread/fork') return fork(s, peer, live, p)
  if (method === 'thread/revert' || method === 'thread/rollback') return revert(s, live, method, p)
  const id = projection.thread.id
  const api = await s.api()
  const options = { directory: live.directory }
  if (method === 'thread/delete') {
    await api.request('DELETE', `/session/${id}`, options)
    s.sessions.deleted(id)
    return {}
  }
  const ref = splitModel((await s.turns.selection(live)).model)
  const failed = (what: string) => (error: Error) =>
    s.notify(id, 'warning', { message: `OpenCode ${what}没有成功：${error.message}` })
  if (method === 'thread/compact/start') {
    if (!ref) throw new ProtocolError(-32602, '这个会话还没有可用的模型，不能压缩')
    // 压缩是 OpenCode 跑的一个回合：带压缩部件的用户消息加一段摘要，事件照常进投影，画成一个上下文压缩条目。
    // 这个请求要到压缩完才回，不等它。
    void api
      .request('POST', `/session/${id}/summarize`, {
        ...options,
        body: { providerID: ref.providerID, modelID: ref.modelID },
      })
      .catch(failed('压缩'))
    return {}
  }
  // thread/shellCommand：经 OpenCode 的 /shell 跑，命令和输出记进会话（模型下一轮看得到），和上游一样。
  const command = requiredString(p.command, 'command')
  void api
    .request('POST', `/session/${id}/shell`, {
      ...options,
      body: {
        agent: live.settings.plan ? 'plan' : 'build',
        command,
        ...(ref ? { model: { providerID: ref.providerID, modelID: ref.modelID } } : {}),
      },
    })
    .catch(failed('运行命令'))
  return {}
}

// 分叉：OpenCode 的 fork 复制某条消息之前（不含）的消息到一个新会话。lastTurnId 保留到那一轮（含），
// 就是从下一轮的那条用户消息切；beforeTurnId 从那一轮起都不要，就是从它切（回合号就是那条用户消息的消息号）。
// 新会话里的消息号是新的、先后不变：适配器记下的输入和插话标记按先后对过去，回显照旧是客户端发来的样子。
async function fork(s: OpencodeServer, peer: RpcPeer, live: LiveThread, p: any): Promise<any> {
  const { thread, turns } = live.projection
  const anchor = p.lastTurnId ?? p.beforeTurnId
  let cut: string | undefined
  if (anchor != null) {
    const index = turns.findIndex((turn) => turn.id === anchor)
    if (index < 0) throw new ProtocolError(-32602, '分叉位置的回合不在该会话当前的历史里')
    cut = turns[p.lastTurnId != null ? index + 1 : index]?.id
  }
  // 临时分叉（官方桌面端起描述用的）照上游不落盘：建在适配器内存里，没有 OpenCode 会话
  if (p.ephemeral === true) {
    const ephemeral = s.openEphemeral(peer, thread.cwd, { ...live.settings })
    const started = envelope(s, ephemeral.projection.thread)
    setImmediate(() => s.notify(started.id, 'thread/started', { thread: started }))
    return settings(s, ephemeral)
  }
  const api = await s.api()
  const options = { directory: live.directory }
  // 目录头必须是原会话的目录：OpenCode 把分叉建在请求所在的目录实例里
  const created = await api.request('POST', `/session/${thread.id}/fork`, {
    ...options,
    body: cut ? { messageID: cut } : {},
  })
  const [before, after] = await Promise.all([
    api.request<any[]>('GET', `/session/${thread.id}/message`, options),
    api.request<any[]>('GET', `/session/${created.id}/message`, options),
  ])
  after.forEach((entry, index) => {
    const from = before[index]?.info?.id
    const to = entry?.info?.id
    if (!from || !to) return
    for (const scope of ['input', 'steer']) {
      const saved = s.store.getMeta(scope, `${thread.id}:${from}`)
      if (saved) s.store.setMeta(scope, `${created.id}:${to}`, saved)
    }
  })
  s.store.setMeta('thread', created.id, { forkedFromId: thread.id })
  s.sessions.saveSettings(created.id, { ...live.settings })
  if (thread.preview) s.store.setMeta('display', created.id, { preview: thread.preview })
  const forked = await s.load(created.id)
  s.subscribe(peer, created.id)
  const resolved = await settings(s, forked)
  const started = { ...resolved.thread, turns: [] }
  setImmediate(() => s.notify(created.id, 'thread/started', { thread: started }))
  return resolved
}

// 回退：OpenCode 的 revert 把会话退到那条用户消息之前，并且把那之后改过的文件恢复原样（照它的快照）；
// 这和 Codex 的 thread/revert 只截断历史、不动文件不一样，声明里写明了（restoresFiles）。
// 退掉的消息在 OpenCode 里还在，下一次发消息时才真删（它自己的界面也不显示），投影照回退点不算它们。
// thread/rollback（按个数，上游已删的旧方法）换算成从哪一轮起不要。
async function revert(s: OpencodeServer, live: LiveThread, method: string, p: any): Promise<any> {
  const { thread, turns } = live.projection
  const index =
    method === 'thread/revert'
      ? turns.findIndex((turn) => turn.id === p.beforeTurnId)
      : Number.isInteger(p.numTurns) && p.numTurns >= 1 && p.numTurns <= turns.length
        ? turns.length - p.numTurns
        : -1
  const first = turns[index]
  if (!first) throw new ProtocolError(-32602, '无效回退边界')
  const api = await s.api()
  await api.request('POST', `/session/${thread.id}/revert`, {
    directory: live.directory,
    body: { messageID: first.id },
  })
  await s.reload(live, false)
  const now = live.projection.turns
  s.notify(thread.id, 'thread/reverted', {})
  return { thread: envelope(s, live.projection.thread), ...historyHeadCursors(thread.id, now) }
}
