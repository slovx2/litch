import { type FileHandle, open, readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { debugLog } from './util.mjs'

// 原生工具执行之前，PreToolUse 钩子要确认这次调用（tool_use 块）已经被 CLI 写进会话记录
// （native-runtime.mts 的 buildOptions）。钩子触发时那一行多半还没写：CLI 把要写的攒一阵才写一批，
// 钩子每隔 25 毫秒再看一次。以前每看一次都用 SDK 的 getSessionMessages 把整个会话记录读出来、
// 逐行解析，一个回合的开销随调用次数平方涨，会话记录跨回合累积，会话越长每次调用越贵。
// 现在每份记录记着处理到哪儿了，每次只读新增的部分，只解析带 tool_use 块的行。
//
// 认哪一行和 SDK（0.3.282）一样：主会话的记录里，type 是 user 或 assistant、有 uuid、不是 isSidechain、
// isMeta、teamName 的行；子代理的记录（同一个会话目录下 subagents/ 里的 agent-<id>.jsonl，可能套在
// workflows/ 之类的子目录里）不看这三项。取文件里第一个带着这个 tool_use 块的行，交出去的 message
// 就是那一行的 message 原样（SDK 也是逐行交，同一条消息的几个内容块各是一行、共用消息 id，不拼起来，
// 用量也是那一行里记的）。和 SDK 不同的一处：SDK 只交从最新一条消息往回连得上的那一串，这里不看
// 连没连上（刚写的这一行总在最新的那一串上，别的分支上不会冒出这次调用的块）。
//
// 文件不只是往后接（依据：CLI 2.1.282 自带的源码）：撤掉一条写坏的消息（removeMessageByUuid，流式回答
// 失败改走别的路时把已经写下的半截消息撤掉）时，那一行在末尾 64KB 以内就在原地截短、把它后面的行挪上来，
// 不在就整个重写一遍；会话记录太大时整理一遍（performCompactTranscript，远程会话才开）是写到临时文件
// 再改名换掉；进出 worktree 时整个会话搬到另一个项目目录，钩子给的路径跟着变。压缩对话（compact_boundary）、
// 回退（--resume-session-at，只在内存里截，新的接在后面成一个分支）都只往后接；分叉是另一个会话、另一个
// 文件。上次写到一半就断了的半行，CLI 下次写之前补一个换行封上，成了解析不了的一行。
// 所以每次先核对：文件换了（设备号加 inode）、比处理到的位置短了、处理到的位置之前的最后 1KB 变了，
// 或者记着的那一行已经不是那次调用，都从头整份再读一遍。没有换行的半行不算数，留到写完再看。
// 读到的都是当场从文件里读出来的，记住的只是哪次调用在哪一行。

/** 一次最多读这么多字节；一行比它长时接着往下读，拼起来 */
const CHUNK = 4 << 20
/** 处理到的位置之前留这么多字节，下次先核对 */
const PRINT = 1024
/** 一份记录里最多记住这么多次调用在哪一行（先进先出）；钩子很快就来认领，用不了这么多 */
const REMEMBERED = 4096
/** 最多同时跟着这么多份记录（主会话一份，每个子代理各一份），多了丢掉最久没用的 */
const TRANSCRIPTS = 256
/** 带 tool_use 块的行里一定有这一段；只有工具结果的行里是 "tool_use_id"，对不上 */
const TOOL_USE = Buffer.from('"tool_use"')

type Message = Record<string, unknown>

export interface TranscriptTailStats {
  /** 从文件里读了多少字节 */
  bytesRead: number
  /** 解析了多少行 */
  linesParsed: number
  /** 认出文件被改过、从头再读了几次 */
  rescans: number
}

/** 一份会话记录：主会话的，或者某个子代理的 */
export class TranscriptTail {
  readonly stats: TranscriptTailStats = { bytesRead: 0, linesParsed: 0, rescans: 0 }
  /** 文件的身份（设备号加 inode），换了文件就不一样；还没打开过时是 null */
  private identity: string | null = null
  /** 处理到哪儿了：总在一行的开头，前面的行都看过 */
  private offset = 0
  /** offset 之前的最后几个字节 */
  private print = Buffer.alloc(0)
  /** 看过的行里，各次调用在哪一行（字节范围，不含换行） */
  private readonly located = new Map<string, { start: number; end: number }>()
  /** 同一份记录同时只查一次：几次调用的钩子可能一起来 */
  private queue: Promise<unknown> = Promise.resolve()

  readonly path: string
  private readonly subagent: boolean

  constructor(path: string, subagent: boolean) {
    this.path = path
    this.subagent = subagent
  }

  /** 这次调用所在的那一行里的 message；还没写进去（或者文件还不在）时是 null */
  find(toolUseId: string): Promise<Message | null> {
    const run = this.queue.then(() => this.lookup(toolUseId))
    this.queue = run.catch(() => {})
    return run
  }

  private async lookup(toolUseId: string): Promise<Message | null> {
    let handle: FileHandle
    try {
      handle = await open(this.path, 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      const { dev, ino, size } = await handle.stat()
      const identity = `${dev}:${ino}`
      if (identity !== this.identity) this.restart(identity, '文件换了')
      else if (size < this.offset) this.restart(identity, '文件变短了')
      else if (!(await this.intact(handle))) this.restart(identity, '读过的部分变了')
      const known = this.located.get(toolUseId)
      if (known) {
        const line = await this.read(handle, known.start, known.end)
        const message = this.parse(line, known.start, toolUseId)
        if (message) return message
        this.restart(identity, '记着的那一行不在原处了')
      }
      const before = { offset: this.offset, print: this.print }
      const found = await this.scan(handle, size, toolUseId)
      // 刚才核对过之后、读新增部分之前文件被改了的话，读到的新增部分是错位的，前面还会漏掉几行：
      // 读完再核对一遍原来那一截，变了就从头再读（下一次查的时候）
      if (this.offset !== before.offset && before.offset > 0) {
        const start = before.offset - before.print.length
        if (!(await this.read(handle, start, before.offset)).equals(before.print)) {
          this.restart(identity, '读的时候文件被改了')
          return null
        }
      }
      return found
    } finally {
      await handle.close()
    }
  }

  /** 处理到的位置之前的最后几个字节还是不是原样 */
  private async intact(handle: FileHandle): Promise<boolean> {
    if (this.offset === 0) return true
    const bytes = await this.read(handle, this.offset - this.print.length, this.offset)
    return bytes.equals(this.print)
  }

  private restart(identity: string, reason: string): void {
    if (this.identity !== null) {
      this.stats.rescans++
      debugLog('native.transcript.rescan', { path: this.path, reason, offset: this.offset })
    }
    this.identity = identity
    this.offset = 0
    this.print = Buffer.alloc(0)
    this.located.clear()
  }

  /** 从 offset 往后读到 size，处理完整的行；最后没有换行的半行留着，下次从它的开头接着读 */
  private async scan(handle: FileHandle, size: number, toolUseId: string): Promise<Message | null> {
    let found: Message | null = null
    let position = this.offset
    /** 上一块末尾的半行，从 offset 开始 */
    let carry: Buffer | null = null
    while (position < size) {
      const chunk = await this.read(handle, position, Math.min(size, position + CHUNK))
      // 读的时候文件被截短了：下次核对时会认出来
      if (chunk.length === 0) break
      position += chunk.length
      const data: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk
      let cursor = 0
      for (let newline = data.indexOf(10); newline >= 0; newline = data.indexOf(10, cursor)) {
        // 找到了也接着处理后面的行：同一条消息里别的调用要记下位置
        const message = this.parse(data.subarray(cursor, newline), this.offset + cursor, toolUseId)
        found ??= message
        cursor = newline + 1
      }
      if (cursor > 0) this.consume(data.subarray(0, cursor))
      carry = cursor < data.length ? data.subarray(cursor) : null
    }
    return found
  }

  /** 这几个字节（以换行结尾的整行）处理完了 */
  private consume(bytes: Buffer): void {
    this.offset += bytes.length
    this.print =
      bytes.length >= PRINT
        ? Buffer.from(bytes.subarray(bytes.length - PRINT))
        : Buffer.concat([this.print, bytes]).subarray(-PRINT)
  }

  /** 一行（不含换行）：带 tool_use 块的才解析，记下里面各次调用在这一行；是要找的那次就交出 message */
  private parse(line: Buffer, start: number, toolUseId: string): Message | null {
    if (line.indexOf(TOOL_USE) < 0) return null
    this.stats.linesParsed++
    let entry: Record<string, any>
    try {
      entry = JSON.parse(line.toString('utf8'))
    } catch {
      return null
    }
    if (!this.counts(entry)) return null
    let found: Message | null = null
    for (const block of entry.message.content) {
      if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue
      if (block.id === toolUseId) found = entry.message
      // 同一次调用出现在几行里时认第一行，和 SDK 一样
      if (this.located.has(block.id)) continue
      this.located.set(block.id, { start, end: start + line.length })
      if (this.located.size > REMEMBERED)
        this.located.delete(this.located.keys().next().value as string)
    }
    return found
  }

  /** SDK 交不交这一行（见文件开头） */
  private counts(entry: Record<string, any>): boolean {
    if (!entry || typeof entry !== 'object') return false
    if (entry.type !== 'user' && entry.type !== 'assistant') return false
    if (typeof entry.uuid !== 'string') return false
    if (!this.subagent && (entry.isSidechain || entry.isMeta || entry.teamName)) return false
    return Array.isArray(entry.message?.content)
  }

  /** 读 [start, end)；文件在这之前就完了的话读到哪儿算哪儿 */
  private async read(handle: FileHandle, start: number, end: number): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(end - start)
    let filled = 0
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        buffer.length - filled,
        start + filled,
      )
      if (bytesRead === 0) break
      filled += bytesRead
    }
    this.stats.bytesRead += filled
    return buffer.subarray(0, filled)
  }
}

/**
 * 一个 CLI 进程的工具调用要到哪份记录里确认：钩子给的 transcript_path 是主会话的记录（子代理的调用也是），
 * 带着 agent_id 的到这个会话目录下 subagents/ 里找 agent-<id>.jsonl（和 SDK 的 getSubagentMessages 一样）
 */
export class ToolIntentTranscripts {
  private readonly tails = new Map<string, TranscriptTail>()
  /** 子代理的记录在哪：会话目录加子代理 ID → 路径 */
  private readonly agentFiles = new Map<string, string>()

  /** 钩子事件里的这次调用所在的 message；还没写进记录时是 null。事件里没有记录的路径时抛错 */
  async find(event: Record<string, unknown>, toolUseId: string): Promise<Message | null> {
    const main = event.transcript_path
    if (typeof main !== 'string' || !isAbsolute(main) || !main.endsWith('.jsonl'))
      throw new Error('钩子事件里没有会话记录的路径')
    if (typeof event.agent_id !== 'string') return this.tail(main, false).find(toolUseId)
    const path = await this.agentFile(main, event.agent_id)
    return path ? this.tail(path, true).find(toolUseId) : null
  }

  private tail(path: string, subagent: boolean): TranscriptTail {
    let tail = this.tails.get(path)
    if (tail) this.tails.delete(path)
    else tail = new TranscriptTail(path, subagent)
    this.tails.set(path, tail)
    if (this.tails.size > TRANSCRIPTS) this.tails.delete(this.tails.keys().next().value as string)
    return tail
  }

  private async agentFile(main: string, agentId: string): Promise<string | null> {
    if (!agentId || agentId !== basename(agentId) || agentId === '.' || agentId === '..')
      throw new Error('子代理 ID 无效')
    const root = join(main.slice(0, -'.jsonl'.length), 'subagents')
    const key = `${root}\n${agentId}`
    const known = this.agentFiles.get(key)
    if (known) return known
    const name = `agent-${agentId}.jsonl`
    let found: string | null = join(root, name)
    if (!(await isFile(found))) {
      // 没在 subagents/ 下面直接放着的（工作流的子代理）往下找，和 SDK 一样
      let entries: string[]
      try {
        entries = await readdir(root, { recursive: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
      const hit = entries.find((entry) => basename(entry) === name)
      found = hit === undefined ? null : join(root, hit)
      if (found && !(await isFile(found))) found = null
    }
    if (found) {
      this.agentFiles.set(key, found)
      if (this.agentFiles.size > TRANSCRIPTS)
        this.agentFiles.delete(this.agentFiles.keys().next().value as string)
    }
    return found
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * 模型的回复还在不在流。CLI 一条回复里的工具调用是边流边执行的：一个 tool_use 块流完就开始执行、
 * 触发 PreToolUse 钩子，但这个块那一行要等后面的块流完（或者整条回复结束）才写进会话记录。
 * 后面的块流得久时（几个子代理接连派出，每个的任务说明都很长），钩子要一直等到这条回复流完，
 * 不能只等固定的几秒。来源按 parent_tool_use_id 分（主会话是空串，子代理各是派它的那次调用）。
 */
export class ModelStreamWatch {
  /** 开始了还没结束的回复的来源 */
  private readonly open = new Set<string>()
  /** 最近一条回复流完（或者回合结束）的时刻 */
  private endedAt = 0

  observe(message: Record<string, unknown>): void {
    if (message.type === 'result') {
      // 回合结束：流断了没收到 message_stop 的也算完了
      if (this.open.size > 0) this.endedAt = Date.now()
      this.open.clear()
      return
    }
    if (message.type !== 'stream_event') return
    const type = (message.event as Record<string, unknown> | undefined)?.type
    const source = typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : ''
    if (type === 'message_start') this.open.add(source)
    else if (type === 'message_stop') {
      this.open.delete(source)
      this.endedAt = Date.now()
    }
  }

  /** 有回复正在流 */
  get streaming(): boolean {
    return this.open.size > 0
  }

  /** 最近一条回复流完的时刻（毫秒） */
  get lastEnded(): number {
    return this.endedAt
  }
}
