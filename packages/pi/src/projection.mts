import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { clientTools } from './dynamic-tools.mjs'
import { NativeFiles, nativeBranch } from './native-files.mjs'
import type { PiThread, PiTurn } from './store.mjs'

export function textContent(content: any): string {
  return typeof content === 'string'
    ? content
    : (content ?? [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n')
}
/**
 * 客户端发来的一条消息里有技能时，适配器记下它的样子，回显和读历史都照它还原。
 * Pi 收到的是 /skill:名字 加上后面的话，开头那一项它展开成技能的正文（<skill …>…</skill>）存进会话，
 * 不在开头的照字面留着，两样都不是客户端发来的样子；而且单看会话认不出来：用户自己在话里写一段同样的
 * <skill …> 存下来是一样的。所以不从 Pi 的消息里认，只照记下的还原。
 * 记的是字、技能、提到的文件，原样；图片只记个位置，数据 Pi 的消息里有，不重复存。没有技能的消息不记，
 * 照 Pi 的消息显示。记下的这一份跟着回合的标记条目存在原生会话里，分叉、回退时和回合一起走。
 */
/** 客户端发来、还没对上 Pi 里那条用户消息的一条消息：它的标识，和带技能时记下的样子（inputRecord） */
export interface SentMessage {
  clientId: string | null
  input: any[] | null
}
export function inputRecord(input: any[]): any[] | null {
  if (!input.some((item) => item?.type === 'skill')) return null
  return input.map((item) =>
    item.type === 'text'
      ? { type: 'text', text: item.text, text_elements: item.text_elements ?? [] }
      : item.type === 'skill' || item.type === 'mention'
        ? { type: item.type, name: item.name, path: item.path }
        : { type: 'image' },
  )
}
/** 照记下的样子还原用户消息的内容：图片按先后取 Pi 消息里的那几张 */
export function restoredContent(record: any[], content: any[]): any[] {
  const images = content.filter((c) => c.type === 'image')
  return record.flatMap((item) => (item.type === 'image' ? (images.shift() ?? []) : [item]))
}
/** 会话的预览：头一条用户消息里显示出来的字，技能、提到的文件、图片都不算（和上游一样） */
export function previewOf(content: any[]): string {
  return textContent(content).slice(0, 200)
}
export function messageItems(message: any, record?: any[] | null): any[] {
  const id = `${message.role}:${message.timestamp}`
  if (message.role === 'user') {
    const content =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content, text_elements: [] }]
        : message.content.map((c: any) =>
            c.type === 'image'
              ? { type: 'image', url: `data:${c.mimeType};base64,${c.data}` }
              : { type: 'text', text: c.text ?? '', text_elements: [] },
          )
    return [
      { type: 'userMessage', id, content: record ? restoredContent(record, content) : content },
    ]
  }
  if (message.role !== 'assistant') return []
  return (message.content ?? []).flatMap((_: any, i: number) => contentItem(message, i) ?? [])
}
/** 助手消息里第 index 个内容块对应的条目；没有条目的块（工具调用）是 undefined */
export function contentItem(message: any, index: number): any {
  const c = message.content?.[index]
  const id = `${message.role}:${message.timestamp}:${index}`
  if (c?.type === 'text')
    return {
      type: 'agentMessage',
      id,
      text: c.text,
      phase: message.stopReason === 'toolUse' ? 'commentary' : 'final_answer',
      memoryCitation: null,
    }
  if (c?.type === 'thinking')
    return { type: 'reasoning', id, summary: [c.thinking ?? ''], content: [] }
  return undefined
}
export function toolItem(
  id: string,
  name: string,
  args: any,
  cwd: string,
  threadId: string,
  dynamicTools: any[] = [],
): any {
  const client = clientTools(dynamicTools).find((tool) => tool.piName === name)
  if (client)
    return {
      type: 'dynamicToolCall',
      id,
      namespace: client.namespace,
      tool: client.name,
      arguments: args,
      status: 'inProgress',
      contentItems: null,
      success: null,
      durationMs: null,
    }
  if (name === 'bash')
    return {
      type: 'commandExecution',
      id,
      command: args.command ?? '',
      cwd,
      processId: null,
      source: 'agent',
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    }
  if (name === 'write' || name === 'edit')
    return { type: 'fileChange', id, status: 'inProgress', changes: [] }
  if (name === 'subagent')
    return {
      type: 'collabAgentToolCall',
      id,
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: threadId,
      receiverThreadIds: [],
      prompt: args.prompt ?? null,
      model: args.model ?? null,
      reasoningEffort: args.thinking ?? null,
      agentsStates: {},
    }
  return {
    type: 'mcpToolCall',
    id,
    server: name.startsWith('mcp__') ? name.split('__')[1] : 'pi',
    tool: name,
    status: 'inProgress',
    arguments: args,
    result: null,
    error: null,
    durationMs: null,
  }
}
/**
 * 父会话里记一笔 gotgenes 的 agentId 对应哪个子会话（runtime.mts 配出来的），重新载入历史时
 * 子代理条目照样指向子线程
 */
export const SUBAGENT_THREAD_ENTRY = 'codex-harness-adapter-subagent'

/** 子代理条目的 receiverThreadIds、agentsStates 用子会话的线程号；还不知道（子会话没建成）时只能用 agentId */
export type SubagentReceiver = (agentId: string) => string

export function finishTool(
  item: any,
  result: any,
  isError: boolean,
  args: any,
  receiver: SubagentReceiver = (agentId) => agentId,
): void {
  item.status = isError ? 'failed' : 'completed'
  const text = textContent(result?.content)
  if (item.type === 'dynamicToolCall') {
    item.success = !isError
    item.contentItems = result?.details?.contentItems ?? [{ type: 'inputText', text }]
    return
  }
  if (item.type === 'commandExecution') {
    item.aggregatedOutput = text
    item.exitCode = result?.details?.exitCode ?? (isError ? 1 : 0)
  } else if (item.type === 'fileChange') {
    if (!isError && !item.changes.length)
      item.changes = [
        {
          path: args.path ?? '',
          kind: { type: 'update', move_path: null },
          diff: result?.details?.patch ?? '',
        },
      ]
  } else if (item.type === 'mcpToolCall') {
    item.result = {
      content: result?.content ?? [],
      structuredContent: result?.details ?? null,
      _meta: null,
    }
    item.error = isError ? { message: text } : null
  } else if (item.type === 'collabAgentToolCall' && result?.details?.agentId) {
    const id = receiver(result.details.agentId)
    item.receiverThreadIds = [id]
    const status = result.details.status
    item.agentsStates = {
      [id]: {
        status:
          isError || ['failed', 'error'].includes(status)
            ? 'errored'
            : ['background', 'running', 'queued'].includes(status)
              ? 'running'
              : status === 'stopped'
                ? 'shutdown'
                : 'completed',
        message: text || null,
      },
    }
  }
}
/**
 * 用户在审批里否决的调用。命令和文件改动有专门的状态；没跑，所以没有输出和退出码。
 * 别的条目类型协议里没有这种状态，留着失败，原因在它的错误信息里。
 */
export function declineItem(item: any): void {
  if (item.type === 'commandExecution') {
    item.status = 'declined'
    item.aggregatedOutput = null
    item.exitCode = null
  } else if (item.type === 'fileChange') item.status = 'declined'
}
export function projectHistory(entries: any[], thread: PiThread): PiTurn[] {
  const turns: PiTurn[] = []
  let turn: PiTurn | undefined
  let ended = false
  // 还没对上用户消息的客户端消息，按先后：回合开头那条、之后每条插话。标记条目里记着它的标识和样子
  const pending: SentMessage[] = []
  const calls = new Map<string, { item: any; args: any }>()
  // 被用户否决的调用：标记记在工具结果之前，结果到了再落到条目上。
  const declined = new Set<string>()
  // 后台子代理的子会话可能在工具结果之后才建，先整个扫一遍
  const subagentThreads = new Map<string, string>()
  for (const entry of entries)
    if (entry.type === 'custom' && entry.customType === SUBAGENT_THREAD_ENTRY)
      subagentThreads.set(entry.data.agentId, entry.data.threadId)
  const receiver: SubagentReceiver = (agentId) => subagentThreads.get(agentId) ?? agentId
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === 'codex-harness-adapter-declined')
      declined.add(entry.data.id)
    if (entry.type === 'custom' && entry.customType === 'codex-harness-adapter-file-change') {
      const call = calls.get(entry.data.id)
      if (call)
        call.item.changes = entry.data.changes.map((change: any) =>
          change.kind.type === 'add' && typeof call.args.content === 'string'
            ? { ...change, diff: call.args.content }
            : change,
        )
    }
    if (entry.type === 'custom' && entry.customType === 'subagents:record') {
      const id = receiver(entry.data.id)
      for (const previous of turns)
        for (const item of previous.items)
          if (item.type === 'collabAgentToolCall' && item.receiverThreadIds.includes(id))
            item.agentsStates = {
              [id]: {
                status: entry.data.error
                  ? 'errored'
                  : entry.data.status === 'stopped'
                    ? 'shutdown'
                    : 'completed',
                message: entry.data.error ?? entry.data.result ?? null,
              },
            }
    }
    if (entry.type === 'custom' && entry.customType === 'codex-harness-adapter-turn') {
      const { input, ...data } = entry.data
      turn = {
        ...data,
        items: [],
        status: 'interrupted',
        error: null,
        completedAt: null,
        durationMs: null,
      }
      turns.push(turn!)
      ended = false
      pending.length = 0
      pending.push({ clientId: data.clientId ?? null, input: input ?? null })
    }
    if (entry.type === 'custom' && entry.customType === 'codex-harness-adapter-steer')
      pending.push({ clientId: entry.data.clientId ?? null, input: entry.data.input ?? null })
    if (
      entry.type === 'custom' &&
      entry.customType === 'codex-harness-adapter-turn-end' &&
      turn &&
      turn.id === entry.data?.id
    ) {
      Object.assign(turn, entry.data)
      ended = true
    }
    if (entry.type === 'compaction') {
      if (!turn || ended) {
        const at = Date.parse(entry.timestamp)
        turn = {
          id: `native:${entry.id}`,
          items: [],
          status: 'completed',
          error: null,
          startedAt: at,
          completedAt: at,
          durationMs: 0,
        }
        turns.push(turn)
      }
      turn.items.push({ type: 'contextCompaction', id: `compact:${entry.id}` })
    }
    if (entry.type !== 'message') continue
    const msg = entry.message
    if (
      !turn ||
      ended ||
      (msg.role === 'user' &&
        turn.items.length &&
        (ended || !turn.id.startsWith('codex-harness-adapter:')))
    ) {
      turn = {
        id: `native:${entry.id}`,
        items: [],
        status: 'completed',
        error: null,
        startedAt: msg.timestamp ?? Date.parse(entry.timestamp),
        completedAt: null,
        durationMs: null,
      }
      turns.push(turn)
      ended = false
      // 不是适配器发起的回合（在 Pi 自己的命令行里说的）：前面没对上的不再往这里对
      pending.length = 0
    }
    const sent = msg.role === 'user' ? pending.shift() : undefined
    for (const item of messageItems(msg, sent?.input)) {
      if (item.type === 'userMessage') item.clientId = sent?.clientId ?? null
      turn.items.push(item)
    }
    if (msg.role === 'assistant')
      for (const c of msg.content ?? [])
        if (c.type === 'toolCall') {
          const item = toolItem(
            c.id,
            c.name,
            c.arguments,
            thread.cwd,
            thread.id,
            thread.dynamicTools,
          )
          calls.set(c.id, { item, args: c.arguments })
          turn.items.push(item)
        }
    if (msg.role === 'toolResult') {
      const call = calls.get(msg.toolCallId)
      if (call) finishTool(call.item, msg, msg.isError, call.args, receiver)
      if (call && declined.has(msg.toolCallId)) declineItem(call.item)
      if (msg.details?.source === 'plan_mode_complete')
        turn.items.push({ type: 'plan', id: `plan:${msg.toolCallId}`, text: msg.details.plan })
    }
    turn.completedAt = msg.timestamp ?? Date.parse(entry.timestamp)
    turn.durationMs = turn.completedAt! - turn.startedAt
  }
  return turns
}

/**
 * 原生会话里最后一个适配器回合的时间（毫秒，没有就是 0）：结束了的按结束标记里记的结束时间，没记下结束的
 * （适配器中途退出了）按开始时间。结束时间和回合结束时内存里记的最后活动是同一个数（turn.mts 的 finishTurn），
 * 重新扫文件（重启、文件变了）前后一样。只认适配器自己的回合标记，扩展在会话打开、关闭时记的状态不算
 */
function lastTurnAt(entries: any[]): number {
  let at = 0
  for (const e of entries) {
    if (e.type !== 'custom') continue
    const time =
      e.customType === 'codex-harness-adapter-turn-end'
        ? e.data?.completedAt
        : e.customType === 'codex-harness-adapter-turn'
          ? e.data?.startedAt
          : undefined
    if (typeof time === 'number' && time > at) at = time
  }
  return at
}

// 索引只读取 JSONL；禁止调用可能迁移/修复会话文件的 SessionManager.open。
export async function discoverSessions(
  directory: string,
  files = new NativeFiles(),
): Promise<Array<{ thread: PiThread; entries: any[] }>> {
  const found: Array<{ thread: PiThread; entries: any[] }> = []
  const walk = async (dir: string): Promise<void> => {
    let names: import('node:fs').Dirent[]
    try {
      names = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const name of names) {
      const path = join(dir, name.name)
      if (name.isDirectory()) {
        await walk(path)
        continue
      }
      if (!name.name.endsWith('.jsonl') || !name.isFile()) continue
      try {
        const entries = files.read(path)
        const header = entries[0]
        if (
          header?.type !== 'session' ||
          typeof header.id !== 'string' ||
          typeof header.cwd !== 'string'
        )
          continue
        const nameEntry = entries.filter((e) => e.type === 'session_info').at(-1)
        const at = entries.findIndex((e) => e.type === 'message' && e.message.role === 'user')
        // 头一条用户消息带着技能时，照它所在回合的标记条目里记下的样子算（见 inputRecord）；
        // 那个回合在这条消息之前就结束了的话，这条不是它的
        const opened = entries
          .slice(0, Math.max(at, 0))
          .findLast(
            (e) =>
              e.type === 'custom' &&
              ['codex-harness-adapter-turn', 'codex-harness-adapter-turn-end'].includes(
                e.customType,
              ),
          )
        const branch = nativeBranch(entries)
        const model = branch.filter((e) => e.type === 'model_change').at(-1)
        const effort = branch
          .filter((e) => e.type === 'thinking_level_change')
          .at(-1)?.thinkingLevel
        const plan = branch
          .filter((e) => e.type === 'custom' && e.customType === 'plan-mode-state')
          .at(-1)?.data
        // 最后更新时间按最后一条消息和最后一个回合算，不按文件的最后一条记录算：扩展在会话打开、关闭时
        // 会往文件里记自己的状态（比如计划模式），那只是有人看了一眼，不算会话有了新内容。
        // 按最后一条记录算的话，在客户端里点开看一下，这个会话就排到最前面去了。
        // 回合算是照上游（会话记录最后写入的时间，回合开始、结束的事件也算）：只走了扩展命令的回合
        // （/plan 打开菜单又跳过）一条消息都不写，它也是会话有了动静，见 lastTurnAt。
        // 也不早于文件头的时间（会话建立的那一刻）：分叉出来的会话（经 thread/fork 或 Pi 自己的 /fork）
        // 文件里的消息、回合标记是从源会话照抄的、带着源会话那时的时间，照上游它的最后活动是分叉那一刻
        const lastMessage = entries.findLast((e) => e.type === 'message')
        const createdAt = Math.floor(Date.parse(header.timestamp) / 1000)
        found.push({
          thread: {
            id: header.id,
            path,
            cwd: header.cwd,
            name: nameEntry?.name ?? null,
            preview:
              at < 0
                ? ''
                : previewOf(
                    messageItems(
                      entries[at].message,
                      opened?.customType === 'codex-harness-adapter-turn'
                        ? opened.data?.input
                        : null,
                    )[0].content,
                  ),
            createdAt,
            updatedAt: Math.max(
              createdAt,
              Math.floor(Date.parse(lastMessage?.timestamp ?? header.timestamp) / 1000),
              Math.floor(lastTurnAt(entries) / 1000),
            ),
            ephemeral: false,
            model: model ? `${model.provider}/${model.modelId}` : null,
            effort: effort ?? null,
            planMode: plan?.enabled ?? false,
            dynamicTools: [],
            forkedFromId: null,
            // gotgenes 使用原生父会话 ID；Pi fork 使用文件路径，不能混为子代理，是分叉的来源。
            ...(typeof header.parentSession === 'string' &&
            /^[0-9a-f-]{36}$/i.test(header.parentSession)
              ? { parentThreadId: header.parentSession }
              : {
                  parentThreadId: null,
                  forkedFromPath:
                    typeof header.parentSession === 'string' && header.parentSession
                      ? resolve(header.parentSession)
                      : null,
                }),
          },
          entries,
        })
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
    }
  }
  await walk(directory)
  return found
}
