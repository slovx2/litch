// 给一个文件的内容上色。上色放在工作线程里（highlight.worker.ts），不占界面的线程；
// 工作线程起不来的环境（被内容安全策略拦了、浏览器不支持）里，小文件退回到在界面的线程里上色，大文件就不上色了。
// 同一时间只上一份：换了文件，上一份没上完的连工作线程一起停掉，换一个新的。
import { parseSpans, type SpanNode, splitSpanLines } from '@litch/core'
import { LINE_PAINT_MAX, MAIN_PAINT_MAX } from './lines.ts'
import type { PaintReply, PaintRequest } from './paint-types.ts'

/** 这一份是在哪上的色。none：没上（不认识的语言、行太长、文件太大又没有工作线程） */
export type PaintMode = 'worker' | 'main' | 'none'

export interface PaintSink {
  /** 一批上好色的行到了：从第 from 行（从 0 起）开始 */
  lines(from: number, lines: SpanNode[][]): void
  done(mode: PaintMode): void
}

interface Job {
  id: number
  text: string
  language: string
  sink: PaintSink
  /** 工作线程走不通、退回到界面的线程里上色之后，“不要了”要通知的是那一头 */
  cancel?: () => void
}

let worker: Worker | null = null
/** 工作线程起不来。记住了就不再试 */
let broken = false
let seq = 0
let current: Job | null = null

const nothing = () => {}

/** 在界面的线程里上色：只给小文件用 */
function paintHere(job: Job): () => void {
  if (job.text.length > MAIN_PAINT_MAX) {
    job.sink.done('none')
    return nothing
  }
  let cancelled = false
  import('highlight.js/lib/common').then(
    (module) => {
      if (cancelled) return
      const hljs = module.default
      if (!hljs.getLanguage(job.language)) {
        job.sink.done('none')
        return
      }
      const html = hljs.highlight(job.text, { language: job.language, ignoreIllegals: true }).value
      job.sink.lines(0, splitSpanLines(parseSpans(html)))
      job.sink.done('main')
    },
    () => {
      if (!cancelled) job.sink.done('none')
    },
  )
  return () => {
    cancelled = true
  }
}

function spawn(): Worker | null {
  if (broken || typeof Worker === 'undefined') return null
  try {
    const made = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' })
    made.onmessage = (event: MessageEvent<PaintReply>) => {
      const reply = event.data
      const job = current
      if (!job || reply.id !== job.id) return
      if ('done' in reply) {
        current = null
        job.sink.done(reply.painted ? 'worker' : 'none')
      } else {
        job.sink.lines(reply.from, reply.lines)
      }
    }
    // 脚本装载不了（被拦了、文件不在）：这条路走不通，手上这一份改在界面的线程里上
    made.onerror = () => {
      broken = true
      made.terminate()
      if (worker === made) worker = null
      const job = current
      current = null
      if (job) job.cancel = paintHere(job)
    }
    return made
  } catch {
    broken = true
    return null
  }
}

/**
 * 给 text 上色，结果一批一批交给 sink。longest 是最长的一行有多少字：有太长的行就不上。
 * 返回“不要了”的函数。
 */
export function paintFile(
  text: string,
  language: string | null,
  longest: number,
  sink: PaintSink,
): () => void {
  if (!language || longest > LINE_PAINT_MAX) {
    sink.done('none')
    return nothing
  }
  // 上一份还没上完：它算到一半停不下来，连工作线程一起换掉
  if (current && worker) {
    worker.terminate()
    worker = null
  }
  current = null
  const job: Job = { id: ++seq, text, language, sink }
  worker ??= spawn()
  if (!worker) return paintHere(job)
  current = job
  worker.postMessage({ id: job.id, text, language } satisfies PaintRequest)
  return () => {
    job.cancel?.()
    if (current !== job) return
    current = null
    worker?.terminate()
    worker = null
  }
}
