// 命令输出的上限：太长的只留头尾，中间记下省了多少。
//
// 为什么在核心里截：一条狂打日志的命令能出几十 MB（上游 codex 按至多 8 KB 一条全量发，一次调用最多一万条）。
// 不截的话核心和界面各留一整份，界面展开着看时每一帧都把整段重新排一遍版，切走再切回来还要把整份快照重发一遍。
// 上游自己留的是头尾各 512 KB（unified_exec 的 HeadTailBuffer），官方桌面端流式时只留末尾两万个字；
// 我们只是显示，留得比上游少，头尾都要。
//
// 规矩：留下来的样子只由“到现在为止的全文”决定，和它是怎么分段来的无关。所以实时一段一段接、读历史拿到的整段、
// 重连恢复时拿到半截再接着收，三条路得到的样子一模一样（核心的视图、界面的副本、模拟核心都用这里的函数）：
// - 全文不到 KEEP（HEAD + TAIL + STEP）个字时整段都留。
// - 到了之后，开头留 HEAD 个字上下；末尾从 HEAD + k·STEP 处往后留，k 取让末尾至少有 TAIL 个字的最大值，
//   所以末尾有 TAIL 到 TAIL + STEP 个字上下。中间省掉的记下字数和 UTF-8 字节数。
// - 尽量切在行与行之间：开头那一刀往前、末尾那一刀往后，各找 REACH 个字以内的换行，切在换行之后；
//   找不到（一行太长）就照字数切。REACH 比 TAIL、STEP 都小，所以要找的那一段在收的时候一定已经全到了，
//   找到哪儿只由全文决定。
// - 照字数切时不拆开代理对：开头那一刀落在一对的中间就往前挪一个字，末尾那一刀往后挪一个字。
// - 末尾每多出 STEP 个字才往前收一次，所以每个字平均只被拷贝常数次：一条增量的开销和已经有多长无关。
//
// 字数是 JS 字符串的长度（UTF-16 码元）；给人看的省略量是 UTF-8 字节数，和上游的说法一样。

/** 开头留多少个字 */
export const OUTPUT_HEAD = 16 * 1024
/** 末尾至少留多少个字 */
export const OUTPUT_TAIL = 48 * 1024
/** 末尾攒满这么多才往前收一次 */
export const OUTPUT_STEP = 16 * 1024
/** 一条命令的输出最多留多少个字（头尾加起来，不含界面上的省略记号）。少于它的一个字都不省 */
export const OUTPUT_KEEP = OUTPUT_HEAD + OUTPUT_TAIL + OUTPUT_STEP
/** 切的地方离行与行之间多远以内就挪过去（必须比 STEP 小，见开头的规矩） */
export const OUTPUT_REACH = 2 * 1024

/** 中间省掉的那一段 */
export interface OutputElision {
  /** 省掉了多少个字（UTF-16 码元）。接着往后接的时候靠它算出全文有多长 */
  chars: number
  /** 省掉的部分有多少个 UTF-8 字节。给人看的是它 */
  bytes: number
  /** 省掉的部分之后、末尾留着的那一截 */
  tail: string
}

/** 截过的输出：命令条目上的这两个字段 */
export interface CappedOutput {
  /** 没省过时是全部输出；省过时是开头那一截 */
  output: string
  /** 没省过是 null */
  elided: OutputElision | null
}

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/** 逐字数一段字的 UTF-8 字节。落单的半个代理对按替换符算（3 个字节），和解码时一样 */
function countBytes(text: string): number {
  let bytes = 0
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (isHigh(code) && at + 1 < text.length && isLow(text.charCodeAt(at + 1))) {
      bytes += 4
      at++
    } else bytes += 3
  }
  return bytes
}

/** 连着的一串 ASCII（不在 0x80 以上的） */
const ASCII_RUNS = /[^\u0080-\uffff]+/g
/** 先看开头这么多个字是不是以 ASCII 为主，再决定怎么数 */
const SAMPLE = 256

/**
 * text 里 [from, to) 这一段有多少个 UTF-8 字节。
 * 日志多半是 ASCII 夹着少量别的字：先用正则（在引擎里跑，比逐字数快几倍）把每一串 ASCII 换成一个空格，
 * 只逐字数剩下的（空格隔着，原来不挨着的两个半个代理对不会被凑成一对）；字数的差就是换掉的那些 ASCII 的字节数。
 * 开头一看就以别的字为主的（中文为主的输出），换的那一步反而慢，直接逐字数。两条路数出来的一样
 */
export function utf8Length(text: string, from = 0, to = text.length): number {
  const part = from === 0 && to === text.length ? text : text.slice(from, to)
  const sample = Math.min(part.length, SAMPLE)
  let wide = 0
  for (let at = 0; at < sample; at++) if (part.charCodeAt(at) >= 0x80) wide++
  if (wide * 8 > sample) return countBytes(part)
  const rest = part.replace(ASCII_RUNS, ' ')
  return part.length - rest.length + countBytes(rest)
}

/**
 * 能按位置取字的一段字：一个字符串就是；工具结果的几段合起来的“虚的全文”（text/tool-cap.mts）也是，
 * 它不真的拼出来，省得为了找刀口把几十 MB 再拷一遍
 */
export interface CharSource {
  readonly length: number
  charCodeAt(at: number): number
}

/** at 这一刀是不是正好落在一个代理对的两半之间 */
const splitsPair = (text: CharSource, at: number): boolean =>
  at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at))

/** 全文有 total 个字时，末尾大致从哪个位置（全文里的位置，还没挪到行与行之间）往后留 */
export const tailStart = (total: number): number =>
  OUTPUT_HEAD + Math.floor((total - OUTPUT_HEAD - OUTPUT_TAIL) / OUTPUT_STEP) * OUTPUT_STEP

const NEWLINE = 10

/** 开头那一截留到哪（不含）：HEAD 往前 REACH 个字以内最后一个换行之后；没有换行就是 HEAD，躲开代理对 */
function headEnd(whole: CharSource): number {
  for (let at = OUTPUT_HEAD; at > OUTPUT_HEAD - OUTPUT_REACH; at--) {
    if (whole.charCodeAt(at - 1) === NEWLINE) return at
  }
  return splitsPair(whole, OUTPUT_HEAD) ? OUTPUT_HEAD - 1 : OUTPUT_HEAD
}

/**
 * 末尾那一截从 text 的哪里开始：at 往后 REACH 个字以内第一个换行之后（at 本来就在行首就是 at）；
 * 没有换行就是 at，躲开代理对。调用的一方保证 text 里 at 前面至少有一个字、后面至少有 REACH 个字
 */
function tailCut(text: CharSource, at: number): number {
  for (let next = at; next < at + OUTPUT_REACH; next++) {
    if (text.charCodeAt(next - 1) === NEWLINE) return next
  }
  return splitsPair(text, at) ? at + 1 : at
}

/**
 * 一整段字按上限该在哪两处下刀：开头留 [0, head)，末尾留 [start, 全文长)，中间的省掉。没到上限是 null。
 * 一段一段接出来的（appendOutput）和整段截的（capOutput、工具结果的 text/tool-cap.mts）都按它切
 */
export function cutPoints(whole: CharSource): { head: number; start: number } | null {
  if (whole.length < OUTPUT_KEEP) return null
  return { head: headEnd(whole), start: tailCut(whole, tailStart(whole.length)) }
}

/**
 * 拷成自己的一份字。从一大段里切下来的一截（slice）在 V8 里只是指着原文的一个窗口，原文整段跟着活下去：
 * 从几十 MB 的输出里截下头尾八万个字，那几十 MB 也就一直留在核心里（核心留着的条目和通道上交出去的增量
 * 共用字符串，见 value.mts）。先拼上一个字（得到的是拼接的节点），再切掉它：切之前引擎要把拼起来的那段拷成一整块，
 * 切出来的只指着这份新的。只在下刀的那一下用，拷的是留下的那一截
 */
export const ownText = (text: string): string => (text === '' ? text : `${text} `.slice(0, -1))

/** 截过的输出全文有多少个字 */
export const outputLength = (capped: CappedOutput): number =>
  capped.output.length + (capped.elided ? capped.elided.chars + capped.elided.tail.length : 0)

/**
 * 往输出后面接一段，返回接好的（不改传进来的）。
 * 没到上限时就是拼起来；到了上限、或者已经省过的，按开头的规矩收。拷贝只发生在往前收的那一下，
 * 每 STEP 个字至多一次，拷的是末尾那一截（TAIL + STEP 个字上下）加上这一段
 */
export function appendOutput(current: CappedOutput, text: string): CappedOutput {
  if (text === '') return current
  const { output, elided } = current
  if (!elided) {
    const whole = output + text
    const cut = cutPoints(whole)
    if (!cut) return { output: whole, elided: null }
    // 头一回超过上限：整段在手里，两刀一起切
    const { head, start } = cut
    return {
      output: ownText(whole.slice(0, head)),
      elided: {
        chars: start - head,
        bytes: utf8Length(whole, head, start),
        tail: ownText(whole.slice(start)),
      },
    }
  }
  const joined = elided.tail + text
  // 末尾现在从全文的 from 处开始。上一刀大致落在 nominal 上、往后挪了不到 REACH 个字到 from；
  // nominal 没变就不用收，变了一定往后跳了整整一步（STEP 比 REACH 大），落在 from 后面
  const from = output.length + elided.chars
  const nominal = tailStart(from + joined.length)
  if (nominal <= from) return { output, elided: { ...elided, tail: joined } }
  const cut = tailCut(joined, nominal - from)
  return {
    output,
    elided: {
      chars: elided.chars + cut,
      bytes: elided.bytes + utf8Length(joined, 0, cut),
      tail: ownText(joined.slice(cut)),
    },
  }
}

/**
 * 要接上去的一大段，中间一截只带着字数和字节数（内容不带）：通道把同一帧里接到同一条命令输出上的字并起来，
 * 太长时只发它（channel/server.mts）。不管接在什么样的输出后面，中间那截都落在要省掉的那一段里，
 * 所以收的一方照样接得出一模一样的结果（appendSkipping）。靠的是两头留够：
 * - text 至少 HEAD + 1 个字：开头那一刀只看全文的前 HEAD + 1 个字（往前找换行、看是不是拆开代理对），
 *   接在多短的输出后面都在已知的字里；
 * - tail 至少 TAIL + STEP 个字：末尾那一刀落在全文的 nominal 往后 REACH 个字以内，看的是 nominal - 1 起的字，
 *   而 nominal 离全文的末尾至多 TAIL + STEP - 1 个字。
 * 中间那截的两头不拆开代理对（text 的最后一个字不是代理对的前一半，tail 的第一个字不是后一半），字节数才能分段加起来
 */
export interface SkippingOutput {
  text: string
  skipped: { chars: number; bytes: number }
  tail: string
}

/** 并起来的一段超过这么多个字才只留头尾：省掉的至少有一步（STEP）那么多，不然不值当 */
export const SKIP_AT = OUTPUT_HEAD + 1 + OUTPUT_TAIL + 2 * OUTPUT_STEP
/** 只留头尾时末尾留多少 */
const SKIP_TAIL = OUTPUT_TAIL + OUTPUT_STEP

/** 一大段只留头尾（规矩见 SkippingOutput）。不到 SKIP_AT 个字的不省，给 null */
export function skipOutput(text: string): SkippingOutput | null {
  if (text.length <= SKIP_AT) return null
  let from = OUTPUT_HEAD + 1
  if (isHigh(text.charCodeAt(from - 1))) from++
  let to = text.length - SKIP_TAIL
  if (isLow(text.charCodeAt(to))) to--
  return {
    text: text.slice(0, from),
    skipped: { chars: to - from, bytes: utf8Length(text, from, to) },
    tail: text.slice(to),
  }
}

/** 只留头尾的一段后面再接一段：接在末尾，末尾比 SKIP_TAIL 多出一步时把前面多的那截并进中间 */
export function extendSkipping(current: SkippingOutput, more: string): SkippingOutput {
  const tail = current.tail + more
  if (tail.length <= SKIP_TAIL + OUTPUT_STEP) return { ...current, tail }
  let cut = tail.length - SKIP_TAIL
  if (isLow(tail.charCodeAt(cut))) cut--
  return {
    text: current.text,
    skipped: {
      chars: current.skipped.chars + cut,
      bytes: current.skipped.bytes + utf8Length(tail, 0, cut),
    },
    tail: tail.slice(cut),
  }
}

/**
 * 往输出后面接一段只留了头尾的（SkippingOutput），结果和把整段接上去（appendOutput）一模一样：
 * 两刀都按全文的规矩算（开头那一刀在已知的字里，末尾那一刀在 tail 里），中间省了多少由几段加起来
 */
export function appendSkipping(current: CappedOutput, more: SkippingOutput): CappedOutput {
  const { text, skipped, tail } = more
  const total = outputLength(current) + text.length + skipped.chars + tail.length
  // 末尾那一刀：tail 在全文里从 tailFrom 起
  const tailFrom = total - tail.length
  const start = tailCut(tail, tailStart(total) - tailFrom)
  const tailBytes = utf8Length(tail, 0, start)
  const kept = ownText(tail.slice(start))
  const { output, elided } = current
  if (elided) {
    return {
      output,
      elided: {
        chars: elided.chars + elided.tail.length + text.length + skipped.chars + start,
        bytes: elided.bytes + utf8Length(elided.tail + text) + skipped.bytes + tailBytes,
        tail: kept,
      },
    }
  }
  // 还没省过：开头那一刀在已经有的输出加上 text 里（text 够长，见 SkippingOutput）
  const known = output + text
  const head = headEnd(known)
  return {
    output: ownText(known.slice(0, head)),
    elided: {
      chars: known.length - head + skipped.chars + start,
      bytes: utf8Length(known, head) + skipped.bytes + tailBytes,
      tail: kept,
    },
  }
}

const EMPTY: CappedOutput = { output: '', elided: null }

/**
 * 上游 codex 自己截过的全文：头尾之间夹着一行“... N bytes omitted ...”，前后各一个换行
 * （unified_exec 的 format_output_omission_marker 和 HeadTailBuffer::to_bytes_with_omission_marker）
 */
const UPSTREAM_MARK = /\n\.\.\. (\d+) bytes omitted \.\.\.\n/g

/**
 * 一整段输出按同样的规矩截好：读历史、恢复会话、条目完成时对面给的是整段。
 * 和一段一段接出来的结果一样，只多一件事：上游 codex 截过的全文里，那行省略说明正好整个落在我们省掉的那一段里时
 * （它的头尾比我们留的长，只要它截过就是这样），把它说省了的字节数也算上、那一行本身不算，
 * 这样实时接着看到的“省了多少”和条目完成之后的差不到一步（STEP + REACH）：末尾从哪里留按全文里的位置对齐，
 * 上游省掉的那些只知道字节数、不知道字数，对齐的位置会错开一点，留的仍是全文的末尾。
 * 那一段里有不止一行这样的字就不认，照实数
 */
export function capOutput(text: string): CappedOutput {
  const capped = appendOutput(EMPTY, text)
  const { output, elided } = capped
  if (!elided) return capped
  const from = output.length
  const to = from + elided.chars
  UPSTREAM_MARK.lastIndex = from
  const marks: RegExpExecArray[] = []
  for (let found = UPSTREAM_MARK.exec(text); found; found = UPSTREAM_MARK.exec(text)) {
    if (found.index + found[0].length > to) break
    marks.push(found)
  }
  const [mark] = marks
  if (marks.length !== 1 || !mark) return capped
  const said = Number(mark[1])
  if (!Number.isSafeInteger(said)) return capped
  return { output, elided: { ...elided, bytes: elided.bytes - utf8Length(mark[0]) + said } }
}
