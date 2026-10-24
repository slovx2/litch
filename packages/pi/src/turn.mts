import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, resolve } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import { outputDelta } from './command-output.mjs'
import { watchNativeSession } from './native-watch.mjs'
import {
  COMPACTION_ITEM_ENTRY,
  contentItem,
  declineItem,
  finishTool,
  inputRecord,
  messageItems,
  previewOf,
  SUBAGENT_THREAD_ENTRY,
  toolItem,
} from './projection.mjs'
import { planState } from './runtime.mjs'
import type { ActiveTurn, PiServer } from './server.mjs'
import type { PiThread, PiTurn } from './store.mjs'

/** write 执行之前文件里的内容，执行完拿它算差异：没有这个文件是 null，读不了是 undefined */
export function contentBefore(cwd: string, path: string): string | null | undefined {
  try {
    return readFileSync(resolve(cwd, path.replace(/^~(?=\/|$)/, homedir())), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
  }
  return undefined
}

export function onEvent(server: PiServer, thread: PiThread, event: any): void {
  if (event.type === 'adapter_idle') setImmediate(() => void server.releaseUnused().catch(() => {}))
  let active = server.active.get(thread.id)
  if (!active && event.type === 'agent_start') {
    const live = server.sessions.get(thread.id)
    if (live) {
      let resolve = () => {}
      const done = new Promise<void>((r) => {
        resolve = r
      })
      const turn = {
        id: `codex-harness-adapter:${randomUUID()}`,
        items: [],
        status: 'inProgress' as const,
        error: null,
        startedAt: Date.now(),
        completedAt: null,
        durationMs: null,
      }
      active = {
        thread,
        turn,
        live,
        stopped: false,
        native: true,
        tools: new Map(),
        done,
        resolve,
        pending: [],
        notices: [],
      }
      server.active.set(thread.id, active)
      // 后台 shell 结束时交给 Pi 的消息开的这一轮：记下来历（只给声明了 backgroundTasks 的连接看）
      server.takeOrigin(thread.id, turn.id)
      live.session.sessionManager.appendCustomEntry('codex-harness-adapter-turn', {
        id: turn.id,
        startedAt: turn.startedAt,
        source: 'pi',
      })
      server.store.saveTurn(thread.id, turn)
      server.notify(thread.id, 'turn/started', { turn })
      server.notify(thread.id, 'thread/status/changed', {
        status: { type: 'active', activeFlags: [] },
      })
      void followNativeTurn(server, active)
    }
  }
  if (event.type === 'session_info_changed') {
    const live = server.sessions.get(thread.id)
    thread.name = live?.session.sessionName ?? null
    server.store.saveThread(thread)
    server.notify(thread.id, 'thread/name/updated', { threadName: thread.name })
  }
  if (event.type === 'extension_error')
    server.notify(thread.id, 'warning', { message: String(event.error?.error ?? event.error) })
  /** 这个事件里新加的、改了的条目：事件处理完只写它们，见末尾 */
  const touched = new Set<any>()
  if (event.type === 'subagent' && event.data?.id) {
    const data = event.data
    if (event.kind === 'session' && typeof data.threadId === 'string') {
      server.subagentThreads.set(data.id, data.threadId)
      server.sessions
        .get(thread.id)
        ?.session.sessionManager.appendCustomEntry(SUBAGENT_THREAD_ENTRY, {
          agentId: data.id,
          threadId: data.threadId,
        })
    }
    const receiver = server.subagentThreads.get(data.id) ?? data.id
    const running = server.background.get(thread.id) ?? new Set<string>()
    if (['completed', 'failed', 'resumed'].includes(event.kind)) {
      running.delete(data.id)
      setImmediate(() => void server.releaseUnused().catch(() => {}))
    } else if (['created', 'started', 'resuming'].includes(event.kind)) running.add(data.id)
    server.background.set(thread.id, running)
    const turns = active ? [active.turn] : server.store.turns(thread.id)
    for (const turn of turns) {
      const item =
        // 子会话建好之前条目上先挂着 agentId，建好时换成子线程号
        turn.items.find(
          (i) =>
            i.type === 'collabAgentToolCall' &&
            (i.receiverThreadIds.includes(receiver) || i.receiverThreadIds.includes(data.id)),
        ) ??
        (active?.turn === turn
          ? turn.items.findLast(
              (i) => i.type === 'collabAgentToolCall' && !i.receiverThreadIds.length,
            )
          : undefined)
      if (!item) continue
      item.receiverThreadIds = [receiver]
      const status =
        event.kind === 'failed'
          ? 'errored'
          : ['completed', 'resumed'].includes(event.kind)
            ? data.error
              ? 'errored'
              : 'completed'
            : 'running'
      item.agentsStates = { [receiver]: { status, message: data.error ?? data.result ?? null } }
      // 进行中的回合随这个事件一起写（末尾），结束了的回合整个写一遍
      if (active?.turn === turn) touched.add(item)
      else server.store.saveTurn(thread.id, turn)
      server.notify(thread.id, 'item/completed', { turnId: turn.id, item })
    }
  }
  if (!active) return
  const { turn } = active
  const notify = (method: string, params: any) =>
    server.notify(thread.id, method, { turnId: turn.id, ...params })
  const put = (item: any, complete: boolean) => {
    // 从后往前找：在流的、刚开始的条目都在末尾，不用每次把回合里已有的条目数一遍
    const index = turn.items.findLastIndex((i) => i.id === item.id)
    if (index < 0) {
      turn.items.push(item)
      // 条目开始时不带内容，字只由随后的增量给出。Pi 给的消息是累计的：一个条目第一次出现时，
      // 里面已经有头一段字了，而这段字紧接着还会作为增量再发一遍；开始时也带上，
      // 客户端按“开始时的字加上增量”算就多出一遍。推理是同样的道理。
      notify('item/started', {
        item:
          item.type === 'reasoning'
            ? { ...item, summary: [], content: [] }
            : item.type === 'agentMessage'
              ? { ...item, text: '' }
              : item,
      })
      if (item.type === 'reasoning')
        notify('item/reasoning/summaryPartAdded', { itemId: item.id, summaryIndex: 0 })
    } else turn.items[index] = item
    touched.add(item)
    if (complete) notify('item/completed', { item })
  }
  if (event.type === 'message_update') {
    // Pi 事件里带的消息是模型流那一头还在往里写的同一个对象：处理到这条事件时，里面可能已经有后面的事件
    // 才说到的字、甚至后面的内容块了；处理事件的这一头比模型流慢多少就超前多少（有扩展在 message_update
    // 里等了一下就会落后一大截）。所以回合里的条目只认已经处理到的事件：这条事件说的是哪一块就只动哪一块，
    // 字按增量接，不看消息里现在有多少。这样条目上的字总是正好等于已经发出去的增量——流到一半时读会话、
    // 恢复会话拿到的不超前，客户端接着收增量不会多出一截；条目的开始也不会抢在前一块的增量前面。
    const delta = event.assistantMessageEvent
    const item = contentItem(event.message, delta?.contentIndex)
    if (item) {
      const old = turn.items.findLast((i) => i.id === item.id)
      // 这一块说完了才认消息里的全文
      const ended = delta.type === 'text_end' || delta.type === 'thinking_end'
      const more = delta.type === 'text_delta' || delta.type === 'thinking_delta' ? delta.delta : ''
      if (!ended && item.type === 'agentMessage') item.text = (old?.text ?? '') + more
      if (!ended && item.type === 'reasoning') item.summary = [(old?.summary[0] ?? '') + more]
      put(item, false)
    }
  }
  if (['message_start', 'message_update', 'message_end'].includes(event.type)) {
    // 助手消息开始时里面有什么都先不认（原因同上），各块随自己的事件出现；结束时整条都定了
    const settled =
      event.type === 'message_end' ||
      (event.type === 'message_start' && event.message.role !== 'assistant')
    // 一条用户消息开始、结束各来一次：头一次对上排着的那条客户端消息，之后沿用
    const user = settled && event.message.role === 'user'
    const old = user ? turn.items.find((i) => i.id === `user:${event.message.timestamp}`) : null
    const sent = user && !old ? active.pending.shift() : undefined
    for (const item of settled ? messageItems(event.message, sent?.input) : []) {
      if (item.type === 'userMessage') {
        item.clientId = old ? old.clientId : (sent?.clientId ?? null)
        if (old) item.content = old.content
      }
      put(item, event.type === 'message_end')
    }
    const delta = event.assistantMessageEvent
    if (delta?.type === 'text_delta')
      notify('item/agentMessage/delta', {
        itemId: `assistant:${event.message.timestamp}:${delta.contentIndex}`,
        delta: delta.delta,
      })
    if (delta?.type === 'thinking_delta')
      notify('item/reasoning/summaryTextDelta', {
        itemId: `assistant:${event.message.timestamp}:${delta.contentIndex}`,
        summaryIndex: 0,
        delta: delta.delta,
      })
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const message = event.message
      if (message.stopReason === 'error')
        turn.error = {
          message: message.errorMessage ?? 'Pi 模型请求失败',
          codexErrorInfo: null,
          additionalDetails: null,
        }
      // 压成了 Pi 会接着请求，再来一条消息时这里跟着改过来
      active.truncated = emptyLength(message)
      const u = message.usage
      const usage = u && {
        totalTokens:
          u.totalTokens ??
          (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
        inputTokens: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
        cachedInputTokens: u.cacheRead ?? 0,
        outputTokens: u.output ?? 0,
        reasoningOutputTokens: 0,
      }
      // 被打断或失败的请求用量全为零；上报会把桌面的上下文占用清零。
      if (usage && (usage.totalTokens || usage.inputTokens || usage.outputTokens)) {
        const previous = server.store.getMeta('usage', thread.id) ?? {
          totalTokens: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        }
        const total = Object.fromEntries(
          Object.entries(usage).map(([k, v]) => [k, (previous[k] ?? 0) + v]),
        )
        const modelContextWindow = active.live?.session.model?.contextWindow ?? null
        server.store.setMeta('usage', thread.id, total)
        // 恢复线程时回放最近一次请求的用量，见 restoreUsage。
        server.store.setMeta('usage-last', thread.id, {
          turnId: turn.id,
          last: usage,
          modelContextWindow,
        })
        notify('thread/tokenUsage/updated', {
          tokenUsage: { total, last: usage, modelContextWindow },
        })
      }
    }
  }
  if (event.type === 'tool_execution_start') {
    const item = toolItem(
      event.toolCallId,
      event.toolName,
      event.args,
      thread.cwd,
      thread.id,
      thread.dynamicTools,
    )
    const before =
      event.toolName === 'write' ? contentBefore(thread.cwd, event.args.path) : undefined
    active.tools.set(event.toolCallId, { item, args: event.args, before })
    put(item, false)
  }
  if (event.type === 'tool_execution_update') {
    const call = active.tools.get(event.toolCallId)
    if (call?.item.type === 'commandExecution') {
      // Pi 给的是到这一刻为止的快照，不是新增的一段；工具一开始还会给一份空的
      const delta = outputDelta(call, event.partialResult)
      touched.add(call.item)
      if (delta) notify('item/commandExecution/outputDelta', { itemId: event.toolCallId, delta })
    }
  }
  if (event.type === 'tool_execution_end') {
    const call = active.tools.get(event.toolCallId)
    if (call) {
      const journal = active.live?.session.sessionManager
      // 审批之前放到条目上的差异是预先算的。真的执行成了，换成按实际结果算的，和不问时一样；
      // 没执行成（被否决、出错）的就只有预先算的这份，记进原生会话，重新载入时还看得到。
      if (call.preview && !event.isError) call.item.changes = []
      if (call.preview && event.isError)
        journal?.appendCustomEntry('codex-harness-adapter-file-change', {
          id: event.toolCallId,
          changes: call.item.changes,
        })
      if (call.item.type === 'fileChange' && !event.isError && call.before !== undefined) {
        const path = call.args.path
        call.item.changes = [
          {
            path,
            kind: call.before === null ? { type: 'add' } : { type: 'update', move_path: null },
            // 协议 add 承载文件正文，只有 update 承载 unified diff。
            diff:
              call.before === null
                ? call.args.content
                : createTwoFilesPatch(path, path, call.before, call.args.content),
          },
        ]
        active.live?.session.sessionManager.appendCustomEntry('codex-harness-adapter-file-change', {
          id: event.toolCallId,
          changes: call.item.changes,
        })
      }
      finishTool(
        call.item,
        event.result,
        event.isError,
        call.args,
        (agentId) => server.subagentThreads.get(agentId) ?? agentId,
      )
      if (call.declined) {
        declineItem(call.item)
        journal?.appendCustomEntry('codex-harness-adapter-declined', { id: event.toolCallId })
      }
      put(call.item, true)
    }
    if (event.result?.details?.source === 'plan_mode_complete')
      put({ type: 'plan', id: `plan:${event.toolCallId}`, text: event.result.details.plan }, true)
  }
  // 压缩开始就发条目的开始（照上游），压成了发完成。手动压缩时这个回合在开始之后才开，开始由 compaction.mts 补。
  // 开始时还不知道 Pi 的压缩记录号，条目另起一个号，压成时记下两个号的对应，重画历史时沿用（projection.mts）
  if (event.type === 'compaction_start' && !active.compacting) {
    active.compacting = { type: 'contextCompaction', id: `compact:${randomUUID()}` }
    put(active.compacting, false)
  }
  if (event.type === 'compaction_end' && event.result) {
    const entry = active.live?.session.sessionManager
      .getBranch()
      .findLast((e) => e.type === 'compaction')
    const item =
      active.compacting ?? (entry ? { type: 'contextCompaction', id: `compact:${entry.id}` } : null)
    if (item && entry && active.compacting)
      active.live?.session.sessionManager.appendCustomEntry(COMPACTION_ITEM_ENTRY, {
        id: item.id,
        entry: entry.id,
      })
    if (item) put(item, true)
  } else if (event.type === 'compaction_end' && active.compacting) {
    // 没压成（出错、被打断）：条目不留在回合里，客户端没等到完成，回合结束时当它没压完
    turn.items = turn.items.filter((item) => item !== active.compacting)
    server.store.saveTurn(thread.id, turn)
  }
  if (event.type === 'compaction_end') delete active.compacting
  // 自动压缩（阈值、溢出）的结果；手动压缩是单独的回合，失败由 compaction.mts 记。
  // 失败时 Pi 不停下，照样把满的上下文发出去，原因只在这个事件里，回合结束时报出来（contextError）
  if (event.type === 'compaction_end' && event.reason !== 'manual') {
    if (event.result) {
      delete active.compactionError
      active.truncated = false
    } else if (event.errorMessage) active.compactionError = event.errorMessage
  }
  // 只写这个事件动过的条目，不把整个回合再写一遍（回合里的条目一多、结果一大，每次都写整个回合就是平方级的）。
  // 流式的增量一条一条来，量大：只记一笔、不当场写库，原因见 PiStore.saveItemsLater
  if (event.type === 'message_update' || event.type === 'tool_execution_update')
    server.store.saveItemsLater(thread.id, turn, touched)
  else server.store.saveItems(thread.id, turn, touched)
}

/**
 * 交给 Pi 的那句话（不含图片）。只看字、技能、提到的文件，别的类型跳过：认不出的类型在 promptInput 里报错，
 * 这里还要给回合开始时算预览用（PiServer.start），那时不报错
 */
export function promptText(input: any[]): string {
  const parts: string[] = []
  // 排在最前面的那一项技能。Pi 只认一句话开头的“/skill:名字 后面的话”，名字到第一个空格为止：
  // 和后面的话之间隔的是换行的话，它会把换行连同后面的字都算进名字里，找不到这项技能，原样当成一句话发给模型
  let leading: string | null = null
  for (const item of input) {
    if (item?.type === 'text') parts.push(item.text)
    else if (item?.type === 'skill') {
      if (leading === null && parts.length === 0) leading = item.name
      else parts.push(`/skill:${item.name}`)
    } else if (item?.type === 'mention') parts.push(item.path)
  }
  const rest = parts.join('\n')
  // 斜杠命令（扩展的命令、/skill:、提示模板）照 Pi 自己的交互界面去掉首尾空白再交给 Pi：它的输入框提交之前
  // 整段 trim（interactive-mode 的 onSubmit），而会话认命令名只认到第一个空格，官方桌面端发来的 `/plan\n`
  // 结尾的换行会算进名字里，认不出就当成一句话交给模型。只对去掉空白后以 / 开头的这样做，别的话原样交，回显不变
  if (leading === null && rest.trim().startsWith('/')) return rest.trim()
  return leading === null ? rest : rest ? `/skill:${leading} ${rest}` : `/skill:${leading}`
}

/**
 * 这条消息作为会话头一句时的预览：显示出来的字，带技能的照客户端发来的样子算、技能本身不算（和上游一样）。
 * 和重读原生会话时照 Pi 存下的那条消息算的一样（projection.mts 的 discoverSessions），重启前后不变
 */
export function inputPreview(input: any[]): string {
  const record = inputRecord(input)
  if (record) return previewOf(record)
  const images = input.filter((item) => item?.type === 'image' || item?.type === 'localImage')
  return previewOf([{ type: 'text', text: promptText(input) }, ...images])
}

export async function promptInput(input: any[]): Promise<{ text: string; images: any[] }> {
  if (!Array.isArray(input)) throw new Error('input 必须是数组')
  const images: any[] = []
  for (const item of input) {
    if (item.type === 'localImage') {
      const data = await readFile(item.path)
      const extension = extname(item.path).toLowerCase()
      const mimeType =
        extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg'
      images.push({ type: 'image', mimeType, data: data.toString('base64') })
    } else if (item.type === 'image') {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(item.url ?? '')
      if (!match) throw new Error('Pi 图片输入需要 data URL 或本地文件')
      images.push({ type: 'image', mimeType: match[1], data: match[2] })
    } else if (!['text', 'skill', 'mention'].includes(item.type))
      throw new Error(`不支持输入类型: ${item.type}`)
  }
  return { text: promptText(input), images }
}

export async function runTurn(server: PiServer, active: ActiveTurn, params: any): Promise<void> {
  const { thread, turn, peer } = active
  let unwatch = () => {},
    externalChange = false
  server.notify(thread.id, 'turn/started', { turn })
  server.notify(thread.id, 'thread/status/changed', { status: { type: 'active', activeFlags: [] } })
  try {
    const live = await server.load(thread, peer!, true)
    active.live = live
    if (active.stopped) return
    const session = live.session
    unwatch = watchNativeSession(session, () => {
      externalChange = true
      turn.error = {
        message: '原生会话在执行期间被其他实例修改，请重新加载后继续',
        codexErrorInfo: null,
        additionalDetails: null,
      }
      server.store.setMeta('queue', thread.id, { paused: true })
      session.clearQueue()
      void session.abort()
    })
    if (params.model) {
      const model = session.modelRuntime
        .getModels()
        .find((m) => `${m.provider}/${m.id}` === params.model)
      if (!model) throw new Error(`未知 Pi 模型: ${params.model}`)
      await session.setModel(model)
      thread.model = params.model
    }
    if (params.effort) session.setThinkingLevel(params.effort)
    await server.deliverStopNotice(thread.id, session)
    const sent = active.pending[0]
    session.sessionManager.appendCustomEntry('codex-harness-adapter-turn', {
      id: turn.id,
      startedAt: turn.startedAt,
      clientId: sent?.clientId ?? null,
      ...(sent?.input ? { input: sent.input } : {}),
    })
    const { text, images } = await promptInput(params.input ?? [])
    const state = planState(session)
    const mode = params.collaborationMode?.mode
    const implement =
      state.enabled &&
      state.latestPlan &&
      mode === 'default' &&
      (String(params.clientUserMessageId ?? params.clientMessageId ?? '').startsWith('plan:') ||
        text === `PLEASE IMPLEMENT THIS PLAN:\n${state.latestPlan}`)
    if (implement) {
      let started = false
      const remove = session.subscribe((e) => {
        if (e.type === 'agent_start') started = true
      })
      try {
        await session.prompt('/plan implement')
        await live.waitForExtensionInputs()
        if (!started && session.isIdle)
          throw new Error(active.notices?.at(-1) ?? 'Pi Plan 插件未启动实施回合')
        await session.waitForIdle()
      } finally {
        remove()
      }
    } else {
      if (mode === 'plan' && !state.enabled) await session.prompt('/plan start')
      if (mode === 'default' && state.enabled) await session.prompt('/plan exit')
      // 插件也会不肯切：存着一份“留着以后用”的计划时它不让进计划模式。照原来的模式跑下去，
      // 客户端要的是计划模式、模型却能改文件，所以这个回合不跑，插件的原话作为回合的错误
      const inPlan = Boolean(planState(session).enabled)
      if ((mode === 'plan' || mode === 'default') && (mode === 'plan') !== inPlan)
        throw new Error(active.notices?.at(-1) ?? 'Pi Plan 插件没有切换计划模式')
      await session.prompt(text, { images })
    }
    await session.waitForIdle()
    // 回合里计划模式可能自己变了（用户在插件的那一问里选了“就在这里实施”，插件退出了计划模式）：
    // 告诉订阅着的客户端，不然它们还当计划模式开着
    const planning = Boolean(planState(session).enabled)
    const switched = planning !== Boolean(thread.planMode)
    thread.planMode = planning
    if (switched)
      server.notify(thread.id, 'thread/settings/updated', {
        threadSettings: server.settings(thread),
      })
    thread.name = session.sessionName ?? null
    thread.path = session.sessionFile ?? null
    thread.effort = session.thinkingLevel
  } catch (error) {
    if (process.env.CHA_PI_DEBUG === '1' && error instanceof Error)
      process.stderr.write(`${error.stack}\n`)
    if (!active.stopped)
      turn.error = {
        message: error instanceof Error ? error.message : String(error),
        codexErrorInfo: null,
        additionalDetails: null,
      }
  } finally {
    unwatch()
    await finishTurn(server, active, externalChange)
  }
}

async function followNativeTurn(server: PiServer, active: ActiveTurn): Promise<void> {
  const session = active.live!.session
  let externalChange = false
  const unwatch = watchNativeSession(session, () => {
    externalChange = true
    active.turn.error = {
      message: '原生会话在执行期间被其他实例修改，请重新加载后继续',
      codexErrorInfo: null,
      additionalDetails: null,
    }
    server.store.setMeta('queue', active.thread.id, { paused: true })
    session.clearQueue()
    void session.abort()
  })
  try {
    // agent_start 的通知发生在 SDK 切换运行状态时，下一轮任务再等待完整 settled。
    await new Promise<void>((resolve) => setImmediate(resolve))
    await session.waitForIdle()
  } finally {
    unwatch()
    await finishTurn(server, active, externalChange)
  }
}

/**
 * 停在 length 上、没有一个字的正文也没有工具调用：上下文满了时 Pi 把输出上限压到上下文 − 已用 − 4096，
 * 最少只剩十几个词元，模型连一句话都写不出来。思考不算
 */
function emptyLength(message: any): boolean {
  if (message.stopReason !== 'length') return false
  return !(message.content ?? []).some(
    (block: any) => block.type === 'toolCall' || (block.type === 'text' && block.text?.trim()),
  )
}

/**
 * 上下文满了这个回合却没出错的，报成失败。Pi 把它们当成可恢复的：自动压缩失败照样往下请求，
 * 截断的空回复去掉、压一次再接着做，都失败了回合照常结束，事件之外什么都不留。
 * 不报的话回合是“完成”，用户看不出出了什么事，接着发话（或者被提醒收尾）每次都撞同一堵墙
 */
function contextError(active: ActiveTurn): PiTurn['error'] {
  const { compactionError, truncated } = active
  if (!compactionError && !truncated) return null
  const message = compactionError
    ? `${truncated ? '上下文满了' : '上下文快满了'}，自动压缩失败：${compactionError}`
    : '上下文满了：模型的回答被截断，一个字也没写出来，自动压缩没有进行'
  return { message, codexErrorInfo: null, additionalDetails: null }
}

export async function finishTurn(
  server: PiServer,
  active: ActiveTurn,
  externalChange: boolean,
): Promise<void> {
  const { thread, turn } = active
  const peer =
    (active.peer && server.peers.get(active.peer.id)) ||
    [...(server.subscriptions.get(thread.id) ?? [])].map((id) => server.peers.get(id)).find(Boolean)
  if (!active.stopped && !turn.error) turn.error = contextError(active)
  turn.status = active.stopped ? 'interrupted' : turn.error ? 'failed' : 'completed'
  const completedAt = Date.now()
  turn.completedAt = completedAt
  turn.durationMs = completedAt - turn.startedAt
  if (!externalChange)
    active.live?.session.sessionManager.appendCustomEntry('codex-harness-adapter-turn-end', {
      id: turn.id,
      status: turn.status,
      error: turn.error,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
    })
  // 回合跑完了就是会话有了动静，哪怕没写一条消息（只走了扩展命令，/plan 打开菜单又跳过），照上游。
  // 用的是记进结束标记的那个时间：重新扫原生会话文件时照它算（projection.mts 的 lastTurnAt），重启前后一样
  thread.updatedAt = Math.floor(completedAt / 1000)
  server.store.saveThread(thread)
  server.store.saveTurn(thread.id, turn)
  server.active.delete(thread.id)
  server.notify(thread.id, 'turn/completed', { turn })
  server.notify(thread.id, 'thread/status/changed', { status: { type: 'idle' } })
  server.notify(thread.id, 'thread/settings/updated', { threadSettings: server.settings(thread) })
  active.resolve()
  const queued = server.queue.list(thread.id)[0]
  if (peer && queued && !server.store.getMeta('queue', thread.id)?.paused && !turn.error) {
    // 队列提交使用同一幂等标识，重试不会产生第二次模型执行。
    try {
      server.start(peer, thread, {
        input: queued.input,
        clientUserMessageId: queued.clientUserMessageId,
        queuedSubmissionId: queued.id,
      })
      server.notify(thread.id, 'thread/queue/changed', {})
    } catch (error) {
      server.notify(thread.id, 'warning', { message: String(error) })
    }
  }
  await server.releaseUnused()
}
