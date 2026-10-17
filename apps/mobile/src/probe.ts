// JS 线程的卡顿探针：每 16ms 排一次定时器，看它晚到了多少。晚到说明 JS 线程被占住了，
// 这时候流式更新、点按、滚动驱动的 JS 回调都会跟着慢。每秒往日志（logcat 的 ReactNativeJS）写一行汇总，
// 测量脚本（scripts/bench.mjs）从日志里取。只有链接带 probe=1 时才开。
const TICK = 16

/** 各段 JS 工作这一秒里的总耗时、最长一次、次数（毫秒）。探针没开时也记，开销是两次 performance.now() */
const work = new Map<string, { total: number; max: number; count: number; bytes: number }>()

export function noteWork(kind: string, ms: number, bytes = 0): void {
  const entry = work.get(kind) ?? { total: 0, max: 0, count: 0, bytes: 0 }
  entry.total += ms
  entry.max = Math.max(entry.max, ms)
  entry.count += 1
  entry.bytes += bytes
  work.set(kind, entry)
}

let timer: ReturnType<typeof setInterval> | null = null
let flusher: ReturnType<typeof setInterval> | null = null

export function startProbe(): void {
  if (timer) return
  let last = performance.now()
  let lags: number[] = []
  timer = setInterval(() => {
    const now = performance.now()
    lags.push(Math.max(0, now - last - TICK))
    last = now
  }, TICK)
  flusher = setInterval(() => {
    if (lags.length === 0) return
    const sorted = lags.sort((a, b) => a - b)
    const at = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
    console.log(
      `LITCH_PROBE ${JSON.stringify({
        t: Date.now(),
        ticks: sorted.length,
        lagP50: Math.round(at(0.5)),
        lagP95: Math.round(at(0.95)),
        lagMax: Math.round(sorted[sorted.length - 1] ?? 0),
        over50: sorted.filter((lag) => lag > 50).length,
        work: Object.fromEntries(
          [...work].map(([kind, e]) => [
            kind,
            {
              total: Math.round(e.total),
              max: Math.round(e.max),
              count: e.count,
              kb: Math.round(e.bytes / 1024),
            },
          ]),
        ),
      })}`,
    )
    lags = []
    work.clear()
  }, 1000)
}

export function stopProbe(): void {
  if (timer) clearInterval(timer)
  if (flusher) clearInterval(flusher)
  timer = null
  flusher = null
}

/** 进会话的计时（T4）：从处理打开链接算起，到对话区第一次带内容提交完 */
let openAt: number | null = null

export function markOpen(): void {
  openAt = performance.now()
  stages = {}
}

let stages: Record<string, number> = {}

/** 进会话途中的一站（订阅发出、快照到了、行建好了），记下离开始多久，随 noteFirstContent 一起写出去 */
export function noteOpenStage(name: string): void {
  if (openAt === null || name in stages) return
  stages[name] = Math.round(performance.now() - openAt)
}

export function noteFirstContent(): void {
  if (openAt === null) return
  const ms = performance.now() - openAt
  openAt = null
  console.log(
    `LITCH_PROBE_OPEN ${JSON.stringify({ t: Date.now(), ms: Math.round(ms), ...stages })}`,
  )
  stages = {}
}
