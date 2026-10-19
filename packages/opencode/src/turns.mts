import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { sleep } from '../../shared/src/util.mjs'
import { DEFAULT_EFFORT, splitModel } from './catalog.mjs'
import type { OcTurn } from './projection.mjs'
import { TURN_STOPPED } from './questions.mjs'
import type { LiveThread, OpencodeServer, Preset } from './server.mjs'
import { presetFromParams } from './sessions.mjs'
import { echoContent, messageId, promptInput } from './turn.mjs'

// 发起回合、插话、打断。
//
// 回合由适配器先建（回合号是自己生成、随后交给 OpenCode 的消息号），提示词下一轮事件循环才经 prompt_async 交出去，
// 交到之后 OpenCode 在后台建用户消息、跑模型，回合在会话闲下来（session.idle）时结束。
// 点名了技能或命令（输入里的 skill）的回合经 /command 发：OpenCode 把命令的模板展开成这一句话，别的文字是它的参数。

// 权限档落到 OpenCode 上的做法。OpenCode 发消息时的 tools 参数会整个替换会话自己的权限规则（只有允许、禁止两种），
// 每次发消息都带上：只读档禁用改文件（edit，含 write、apply_patch）、运行命令（bash）和子代理（task）三类工具，
// 模型拿不到它们；别的两档给一条不对应任何工具的规则，等于清掉，完全照 OpenCode 自己的权限设置。
// 完全访问档另由适配器把 OpenCode 来问的一律放行（asks.mts）。
const NEUTRAL_RULE = 'codex-harness-adapter'
export function presetTools(preset: Preset): Record<string, boolean> {
  return preset === ':read-only'
    ? { edit: false, bash: false, task: false }
    : { [NEUTRAL_RULE]: true }
}

export class Turns {
  private readonly server: OpencodeServer

  constructor(server: OpencodeServer) {
    this.server = server
  }

  /** 这个会话下一轮用的模型和强度：会话自己选的，没选的是 OpenCode 配置里的默认模型（再没有是它自己挑的） */
  async selection(live: LiveThread): Promise<{ model: string | null; effort: string | null }> {
    const defaults = this.server.store.getMeta('config', 'defaults') ?? {}
    const model = live.settings.model ?? (await this.server.catalog.defaultModel())
    const effort = live.settings.effort ?? defaults.model_reasoning_effort ?? DEFAULT_EFFORT
    return { model, effort }
  }

  /** turn/start、thread/settings/update 等带来的设置写进会话的设置 */
  async apply(live: LiveThread, params: any, fallback = false): Promise<void> {
    const settings = { ...live.settings }
    const preset = presetFromParams(params)
    if (preset) settings.preset = preset
    const mode = params.collaborationMode?.mode
    if (mode === 'plan' || mode === 'default') settings.plan = mode === 'plan'
    const model = typeof params.model === 'string' && params.model ? params.model : null
    if (model && model !== settings.model) {
      const known = live.projection.thread.ephemeral || (await this.server.catalog.has(model))
      if (known) {
        settings.model = model
        // 换了模型、没一起给强度的，强度回到模型自己的默认（各模型的 variant 不一样）
        if (!params.effort) settings.effort = null
      } else if (!fallback) throw new ProtocolError(-32602, `OpenCode 没有模型 ${model}`)
    }
    if (typeof params.effort === 'string' && params.effort) settings.effort = params.effort
    live.settings = settings
    if (!live.projection.thread.ephemeral)
      this.server.sessions.saveSettings(live.projection.thread.id, settings)
  }

  // 交给 OpenCode 的消息体里和设置有关的几样
  private async body(live: LiveThread, preset: Preset) {
    const { model, effort } = await this.selection(live)
    const ref = splitModel(model)
    const { thread } = live.projection
    return {
      ...(ref ? { model: { providerID: ref.providerID, modelID: ref.modelID } } : {}),
      ...(effort && effort !== DEFAULT_EFFORT ? { variant: effort } : {}),
      ...(live.settings.plan ? { agent: 'plan' } : {}),
      tools: {
        ...presetTools(preset),
        // 子代理的会话直接发话时照 OpenCode 给子代理的默认：不能再派子代理、不记待办
        ...(thread.parentThreadId ? { task: false, todowrite: false } : {}),
        // 动态工具的 MCP 服务只给自己的会话看（client-tools.mts）
        ...this.server.clientTools.rules(thread.id),
      },
      ref,
      effort,
    }
  }

  async start(peer: RpcPeer, live: LiveThread, params: any): Promise<OcTurn> {
    const { projection } = live
    const clientId = params.clientUserMessageId ?? params.clientMessageId ?? null
    if (clientId) {
      const submitted =
        live.submitted.get(clientId) ??
        projection.turns.find((turn) =>
          turn.items.some((item) => item.type === 'userMessage' && item.clientId === clientId),
        )
      if (submitted) return submitted
    }
    if (projection.active) throw new ProtocolError(-32009, '会话已有活动回合')
    const input = promptInput(params.input ?? [])
    await this.apply(live, params, Boolean(params.allowProviderModelFallback))
    const threadId = projection.thread.id
    const notify = (method: string, value: any) => this.server.notify(threadId, method, value)
    this.server.subscribe(peer, threadId)
    const id = messageId()
    this.server.remember(threadId, id, echoContent(params.input ?? []), clientId)
    if (projection.thread.ephemeral) return this.helper(live, id, params)
    const turn = projection.expect(id, live.settings.plan, notify)
    if (clientId) live.submitted.set(clientId, turn)
    const preset = live.settings.preset
    live.turnPreset = preset
    live.starter = { turnId: turn.id, peerId: peer.id }
    const deliver = async () => {
      try {
        const api = await this.server.api()
        await this.server.clientTools.ensure(api, live)
        const { ref, effort, ...body } = await this.body(live, preset)
        const options = { directory: live.directory }
        if (input.command) {
          // /command 一直跑到回合结束才回：不等它，出错时（没有这个命令这类）它也会发 session.error
          const sent = api.request('POST', `/session/${threadId}/command`, {
            ...options,
            body: {
              messageID: id,
              command: input.command,
              arguments: input.text,
              ...(ref ? { model: `${ref.providerID}/${ref.modelID}` } : {}),
              ...(effort && effort !== DEFAULT_EFFORT ? { variant: effort } : {}),
              ...(live.settings.plan ? { agent: 'plan' } : {}),
              parts: input.parts.filter((part) => part.type === 'file'),
            },
          })
          sent.catch((error) => {
            if (projection.active === turn) projection.fail(error.message, notify)
          })
          await Promise.race([sent.catch(() => {}), sleep(200)])
          return
        }
        await api.request('POST', `/session/${threadId}/prompt_async`, {
          ...options,
          body: {
            messageID: id,
            parts: input.parts,
            ...body,
            ...(params.outputSchema != null
              ? { format: { type: 'json_schema', schema: params.outputSchema } }
              : {}),
          },
        })
      } catch (error) {
        if (projection.active === turn)
          projection.fail(error instanceof Error ? error.message : String(error), notify)
      }
    }
    // 回合先回给客户端，提示词随后才交给 OpenCode。
    live.delivered = new Promise((resolve) => setImmediate(() => void deliver().then(resolve)))
    return turn
  }

  // 临时线程上的回合：没有 OpenCode 会话也就没有模型可用。带输出结构的回合（标题、摘要等）以空结果
  // 正常结束，客户端按“没有结果”走自己的回退；普通回合如实拒绝。
  private helper(live: LiveThread, id: string, params: any): OcTurn {
    const { projection } = live
    if (params.outputSchema == null)
      throw new ProtocolError(-32602, 'OpenCode 入口的临时线程不能运行普通回合')
    const threadId = projection.thread.id
    const notify = (method: string, value: any) => this.server.notify(threadId, method, value)
    const turn = projection.expect(id, false, notify)
    setImmediate(() => {
      projection.message({ id, role: 'user', time: { created: Date.now() } }, notify)
      projection.idle(notify)
    })
    return turn
  }

  async steer(live: LiveThread, params: any): Promise<{ turnId: string }> {
    const { projection } = live
    const active = projection.active
    if (!active || active.id !== params.expectedTurnId)
      throw new ProtocolError(-32009, '指定回合与活动回合不一致')
    const input = promptInput(params.input ?? [])
    if (input.command) throw new ProtocolError(-32602, 'OpenCode 的插话不能点名技能或命令')
    // 回合的提示词还没交到、OpenCode 还没建那条用户消息时插话，插话会排在原来那句前面：先等它。
    await this.ready(live, active)
    if (projection.active !== active) throw new ProtocolError(-32009, '指定回合与活动回合不一致')
    const threadId = projection.thread.id
    const id = messageId()
    const clientId = params.clientUserMessageId ?? params.clientMessageId ?? null
    this.server.remember(threadId, id, echoContent(params.input ?? []), clientId)
    this.server.store.setMeta('steer', `${threadId}:${id}`, { turnId: active.id })
    const {
      ref: _ref,
      effort: _effort,
      ...body
    } = await this.body(live, live.turnPreset ?? live.settings.preset)
    // 会话忙着的时候再发一句，OpenCode 在当前这一步结束后把它并进正在跑的循环，不打断正在进行的输出。
    const api = await this.server.api()
    await this.server.clientTools.ensure(api, live)
    await api.request('POST', `/session/${threadId}/prompt_async`, {
      directory: live.directory,
      body: { messageID: id, parts: input.parts, ...body },
    })
    return { turnId: active.id }
  }

  // 等回合真的开始跑：提示词交到了，OpenCode 也建了那条用户消息（最多等几秒）
  private async ready(live: LiveThread, turn: OcTurn): Promise<void> {
    await live.delivered
    for (let waited = 0; waited < 5000 && live.projection.active === turn; waited += 20) {
      if (live.projection.started(turn.id)) return
      await sleep(20)
    }
  }

  async interrupt(id: string): Promise<void> {
    const live = this.server.live.get(id)
    const turn = live?.projection.active
    if (!live || !turn) return
    const { projection } = live
    projection.interrupting = turn.id
    await this.ready(live, turn)
    if (projection.active !== turn) return
    const api = await this.server.api()
    await api.request('POST', `/session/${id}/abort`, { directory: live.directory }).catch(() => {})
    // abort 之后挂着的权限请求和提问 OpenCode 不收拾：自己拒掉，在问用户的撤回并发 serverRequest/resolved
    await this.server.asks.clear(live)
    this.server.requests.reject((threadId) => threadId === id, TURN_STOPPED)
    const notify = (method: string, params: any) => this.server.notify(id, method, params)
    for (let waited = 0; waited < 10000 && projection.active === turn; waited += 50) await sleep(50)
    // OpenCode 迟迟没有回报闲下来（提示词根本没交成这类）时由适配器收尾
    if (projection.active === turn) projection.stop(notify)
  }
}
