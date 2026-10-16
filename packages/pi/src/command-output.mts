import { textContent } from './projection.mjs'

// 命令还在跑时的输出。协议里 item/commandExecution/outputDelta 的意思是“新增的一段”，客户端把它接在
// 已有的后面显示。Pi 的 bash 工具给的却不是新增的一段，而是到这一刻为止的一份快照（至多每 100 毫秒一份）：
// 输出还没超过它保留的量（末尾 2000 行或 50KB）时是全文；超过之后是末尾的一个窗口，窗口跟着输出往后滑，
// 这时快照里另带着“到现在一共输出了多少字节”（details.truncation.totalBytes）。
// 所以新增的一段要从前后两份快照里找：旧窗口的结尾和新窗口的开头对得上的那一截是已经发过的，后面的才是新的。
// 窗口有上限，这里对着它做的事都是线性的，不随命令已经输出了多少涨。

/** 一次命令调用的流式输出记着的东西：item.aggregatedOutput 是上一份快照，seen 是它那时一共输出了多少字节 */
interface StreamingCommand {
  item: any
  seen?: number | undefined
}

/** 收到 Pi 的一份快照：记下它，返回该作为增量发给客户端的那一段（没有新增时是空串，不要发） */
export function outputDelta(call: StreamingCommand, partial: any): string {
  const text = textContent(partial?.content)
  const old: string = call.item.aggregatedOutput ?? ''
  const total = partial?.details?.truncation?.totalBytes
  // 上一份快照还是全文时没有这个数，全文的字节数就是
  const added =
    typeof total === 'number' ? total - (call.seen ?? Buffer.byteLength(old)) : undefined
  call.seen = typeof total === 'number' ? total : undefined
  call.item.aggregatedOutput = text
  return freshOutput(old, text, added)
}

/**
 * 新快照 text 里上一份快照 old 没有的那一段。added 是两份快照之间输出了多少字节，不知道就不给。
 * 以文字对得上为准，字节数只用来在几种都对得上的接法里挑：输出里有重复的内容时（比如一直是同一行），
 * 窗口滑没滑、滑了多少单看文字分不出来；没有字节数就取重叠最长的那种，宁可少发重复的，不把发过的再发一遍。
 */
export function freshOutput(old: string, text: string, added?: number): string {
  // 快照还是全文：新的以旧的开头，多出来的就是新增的
  if (added === undefined && text.startsWith(old)) return text.slice(old.length)
  const span = Math.min(old.length, text.length)
  // KMP 的失配表：fail[i] 是 text 的前 i + 1 个字里，既是开头又是结尾的最长的那一截有多长
  const fail = new Int32Array(span)
  /** 对上了 matched 个字之后接不下去，退到次长的那种对法 */
  const shorter = (matched: number) => fail[matched - 1] as number
  for (let i = 1, k = 0; i < span; i++) {
    while (k > 0 && text.charCodeAt(i) !== text.charCodeAt(k)) k = shorter(k)
    if (text.charCodeAt(i) === text.charCodeAt(k)) k++
    fail[i] = k
  }
  // old 的结尾和 text 的开头最长能对上多少个字
  let overlap = 0
  for (let i = old.length - span; i < old.length; i++) {
    while (overlap > 0 && old.charCodeAt(i) !== text.charCodeAt(overlap)) overlap = shorter(overlap)
    if (old.charCodeAt(i) === text.charCodeAt(overlap)) overlap++
  }
  if (added !== undefined) {
    // 对得上的长度不止一种时顺着失配表一个个往短里找，挑新增的量最接近 added 的。不要求正好相等：
    // 截过的快照末尾的换行多半被 Pi 去掉了，前后会差一个字。新增的量越找越大，开始离得更远就不用再找了
    const want = Math.min(tailLength(text, added), text.length)
    const miss = (length: number) => Math.abs(text.length - length - want)
    for (let length = overlap; length > 0; ) {
      length = shorter(length)
      if (miss(length) >= miss(overlap)) break
      overlap = length
    }
  }
  const fresh = text.slice(overlap)
  // 一个字都对不上：两份快照之间输出的比一个窗口还多，中间那些 Pi 没有给。另起一行，免得前后两行连成一行
  return overlap === 0 && fresh && old && !old.endsWith('\n') ? `\n${fresh}` : fresh
}

/** text 末尾的 bytes 个字节（按 UTF-8 算）是多少个字；text 没有这么多字节时是无穷大 */
function tailLength(text: string, bytes: number): number {
  let length = 0
  for (let left = bytes; left > 0; length++) {
    if (length === text.length) return Number.POSITIVE_INFINITY
    const code = text.charCodeAt(text.length - 1 - length)
    // 代理对的两半各算两个字节，合起来四个
    left -= code < 0x80 ? 1 : code < 0x800 || (code & 0xf800) === 0xd800 ? 2 : 3
  }
  return length
}
