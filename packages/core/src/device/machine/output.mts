// litch_machine 的输出：跨块接着解 UTF-8、按字节掐掉中间、进程输出带序号留一段。
// 核心没有 TextDecoder，字节和文本之间用 text/bytes.mts 的那几样。
import { decodeUtf8 } from '../../text/bytes.mjs'
import { utf8Length } from '../../text/output-cap.mjs'

/** 末尾不完整的 UTF-8 字符从哪个字节开始（完整的话就是长度） */
export function utf8CompleteLength(bytes: Uint8Array): number {
  const length = bytes.length
  // 最多往回看三个字节找一个字符的开头
  for (let back = 1; back <= Math.min(3, length); back++) {
    const byte = bytes[length - back] ?? 0
    if ((byte & 0xc0) === 0x80) continue
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    return need > back ? length - back : length
  }
  return length
}

/** 开头的续字节有几个（从文件中间读起时要跳过，最多三个） */
export function utf8LeadingContinuation(bytes: Uint8Array): number {
  let at = 0
  while (at < Math.min(3, bytes.length) && ((bytes[at] ?? 0) & 0xc0) === 0x80) at++
  return at
}

/** 一路输出的解码器：块边上切开的字符留到下一块再解 */
export function utf8Stream(): { push(bytes: Uint8Array): string; end(): string } {
  let pending: Uint8Array = new Uint8Array(0)
  return {
    push(bytes) {
      const whole = pending.length ? concatBytes([pending, bytes]) : bytes
      const cut = utf8CompleteLength(whole)
      pending = whole.slice(cut)
      return decodeUtf8(whole.subarray(0, cut))
    },
    end() {
      const rest = pending
      pending = new Uint8Array(0)
      return rest.length ? decodeUtf8(rest) : ''
    },
  }
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** 一次回给模型的输出，留头留尾时头占四分之一 */
const HEAD_SHARE = 0.25

/**
 * 超过 maxBytes（UTF-8 字节）就掐掉中间，留开头和末尾，中间写明省了多少字节。
 * 返回的 omitted 是省掉的字节数，没截是 0
 */
export function clipMiddle(text: string, maxBytes: number): { text: string; omitted: number } {
  const total = utf8Length(text)
  if (total <= maxBytes) return { text, omitted: 0 }
  const headBudget = Math.floor(maxBytes * HEAD_SHARE)
  const tailBudget = maxBytes - headBudget
  let head = 0
  let headBytes = 0
  while (head < text.length) {
    const code = text.codePointAt(head) ?? 0
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    if (headBytes + size > headBudget) break
    headBytes += size
    head += code >= 0x10000 ? 2 : 1
  }
  let tail = text.length
  let tailBytes = 0
  while (tail > head) {
    const low = text.charCodeAt(tail - 1)
    const pair = low >= 0xdc00 && low <= 0xdfff && tail - 2 >= head
    const start = pair ? tail - 2 : tail - 1
    const code = text.codePointAt(start) ?? 0
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    if (tailBytes + size > tailBudget) break
    tailBytes += size
    tail = start
  }
  const omitted = total - headBytes - tailBytes
  return {
    text: `${text.slice(0, head)}\n[... ${omitted} bytes omitted ...]\n${text.slice(tail)}`,
    omitted,
  }
}

/** 进程输出里的一段：两路合在一起，按到达的先后排。end 是到这一段末尾为止一共输出了多少字节 */
export interface OutputChunk {
  end: number
  text: string
  bytes: number
}

/**
 * 一个进程的输出：留最近 retainBytes 字节（按块丢）。给模型的序号就是“到这里为止一共输出了多少字节”，
 * 所以读的时候给 afterSeq，丢掉了多少一减就知道
 */
export class OutputLog {
  private readonly chunks: OutputChunk[] = []
  private readonly retainBytes: number
  private kept = 0
  /** 一共输出了多少字节，也是最后一块的序号 */
  totalBytes = 0

  constructor(retainBytes: number) {
    this.retainBytes = retainBytes
  }

  push(text: string): void {
    if (!text) return
    const bytes = utf8Length(text)
    this.totalBytes += bytes
    this.chunks.push({ end: this.totalBytes, text, bytes })
    this.kept += bytes
    // 至少留最后一块，哪怕它自己就超了
    while (this.kept > this.retainBytes && this.chunks.length > 1) {
      const gone = this.chunks.shift()
      if (!gone) break
      this.kept -= gone.bytes
    }
  }

  /** 留着的头一个字节在全部输出里的位置 */
  get keptFrom(): number {
    return this.totalBytes - this.kept
  }

  /** afterSeq 之后的输出合起来；dropped 是其中已经不在了的字节数（留得不够长） */
  after(afterSeq: number): { text: string; dropped: number; seq: number } {
    const from = Math.max(0, Math.min(afterSeq, this.totalBytes))
    const parts = this.chunks.filter((chunk) => chunk.end > from)
    return {
      text: parts.map((chunk) => chunk.text).join(''),
      dropped: Math.max(0, this.keptFrom - from),
      seq: this.totalBytes,
    }
  }
}
