// 两段文字按行比出差异，切成统一差异里的那种段。纯函数。
// 真的差异是设备上的 git 算的；这里给模拟核心里那个假的 git 用（mock/mock-git.mts）。
import type { DiffHunk } from '../model-diff.mjs'

/** 一步：' ' 两边都有，'-' 只有旧的有，'+' 只有新的有 */
export type LineOp = ' ' | '-' | '+'

/** 改动的步数超过这么多就不细比了：中间那一截当成整段换掉 */
const MAX_EDITS = 1500

/**
 * 比两组行，给出从旧的变成新的要走的每一步。一段改动里先列删的、再列加的。
 * 用的是 Myers 的做法：先去掉两头一样的，中间那一截找改动最少的走法
 */
export function lineDiff(
  before: readonly string[],
  after: readonly string[],
  maxEdits = MAX_EDITS,
): LineOp[] {
  let head = 0
  const shorter = Math.min(before.length, after.length)
  while (head < shorter && before[head] === after[head]) head++
  let tail = 0
  while (
    tail < shorter - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++
  }
  const a = before.slice(head, before.length - tail)
  const b = after.slice(head, after.length - tail)
  const middle = myers(a, b, maxEdits) ?? [...a.map((): LineOp => '-'), ...b.map((): LineOp => '+')]
  const ops: LineOp[] = []
  for (let n = 0; n < head; n++) ops.push(' ')
  // 一段改动里删的在前、加的在后
  let minus = 0
  let plus = 0
  const flush = () => {
    for (; minus > 0; minus--) ops.push('-')
    for (; plus > 0; plus--) ops.push('+')
  }
  for (const op of middle) {
    if (op === '-') minus++
    else if (op === '+') plus++
    else {
      flush()
      ops.push(' ')
    }
  }
  flush()
  for (let n = 0; n < tail; n++) ops.push(' ')
  return ops
}

function myers(a: readonly string[], b: readonly string[], maxEdits: number): LineOp[] | null {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return null
  const limit = Math.min(maxEdits, n + m)
  const offset = limit + 1
  const reach = new Int32Array(2 * limit + 3)
  /** 每走一步之前各条斜线走到了哪 */
  const trace: Int32Array[] = []
  for (let d = 0; d <= limit; d++) {
    trace.push(reach.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      const down =
        k === -d ||
        (k !== d && (reach[offset + k - 1] as number) < (reach[offset + k + 1] as number))
      let x = down ? (reach[offset + k + 1] as number) : (reach[offset + k - 1] as number) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      reach[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, d, n, m)
    }
  }
  return null
}

function backtrack(trace: Int32Array[], steps: number, n: number, m: number): LineOp[] {
  const ops: LineOp[] = []
  let x = n
  let y = m
  for (let d = steps; d >= 0; d--) {
    const row = trace[d] as Int32Array
    // 这一行存的是斜线 -d-1 到 d+1
    const at = (k: number): number => row[k + d + 1] as number
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const fromK = down ? k + 1 : k - 1
    const fromX = d === 0 ? 0 : at(fromK)
    const fromY = d === 0 ? 0 : fromX - fromK
    while (x > fromX && y > fromY) {
      ops.push(' ')
      x--
      y--
    }
    if (d > 0) ops.push(down ? '+' : '-')
    x = fromX
    y = fromY
  }
  return ops.reverse()
}

/**
 * 把两组行的差异切成段，每段前后各带 context 行没变的。两段之间隔得近（上下文连得上）的并成一段。
 * 一样的两组行没有段
 */
export function hunksOf(
  before: readonly string[],
  after: readonly string[],
  context: number,
): DiffHunk[] {
  const ops = lineDiff(before, after)
  const hunks: DiffHunk[] = []
  let oldNo = 0
  let newNo = 0
  let open: DiffHunk | null = null
  /** 上一处改动之后已经过了几行没变的 */
  let quiet = 0
  /** 还没放进段里的没变的行（最多留 context 行，给下一段当前面的上下文） */
  let held: string[] = []
  for (const op of ops) {
    if (op === ' ') {
      const line = before[oldNo] as string
      oldNo++
      newNo++
      if (open && quiet < context) {
        open.lines.push(` ${line}`)
        open.oldLines++
        open.newLines++
        quiet++
        continue
      }
      held.push(line)
      quiet++
      // 隔得够远了：这一段到此为止
      if (open && held.length > context) {
        hunks.push(open)
        open = null
      }
      if (held.length > context) held.shift()
      continue
    }
    if (!open) {
      open = {
        oldStart: oldNo - held.length + 1,
        oldLines: 0,
        newStart: newNo - held.length + 1,
        newLines: 0,
        section: '',
        lines: [],
      }
    }
    for (const line of held) {
      open.lines.push(` ${line}`)
      open.oldLines++
      open.newLines++
    }
    held = []
    quiet = 0
    if (op === '-') {
      open.lines.push(`-${before[oldNo] as string}`)
      open.oldLines++
      oldNo++
    } else {
      open.lines.push(`+${after[newNo] as string}`)
      open.newLines++
      newNo++
    }
  }
  if (open) hunks.push(open)
  // 一边一行都没有的段，那一边的起点照 git 的写法是“前一行”（文件开头就是 0）
  for (const hunk of hunks) {
    if (hunk.oldLines === 0) hunk.oldStart--
    if (hunk.newLines === 0) hunk.newStart--
  }
  return hunks
}
