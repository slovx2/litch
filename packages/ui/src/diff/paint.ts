// 给差异里的代码上色。和文件查看器用的是同一个工作线程脚本（files/highlight.worker.ts），但这里另起一个：
// 差异里要上的是很多小份（每个文件旧的一边、新的一边各一份），排着队一份一份来；文件查看器那个一次只上一份，
// 换文件就把上一份连线程一起停掉，两边混用会互相打断。工作线程起不来就不上色，内容照原样显示。
import type { FileDiff, SpanNode } from '@litch/core'
import { LINE_PAINT_MAX } from '../files/lines.ts'
import type { PaintReply, PaintRequest } from '../files/paint-types.ts'
import { sideLines } from './model.ts'

export interface Painted {
  /** 两边各自上好色的行，按 Cell.at 放。还没到的是空着的 */
  old: (SpanNode[] | undefined)[]
  next: (SpanNode[] | undefined)[]
}

interface Job {
  id: number
  file: FileDiff
  text: string
  language: string
  into: (SpanNode[] | undefined)[]
}

const painted = new WeakMap<FileDiff, Painted>()
const listeners = new Set<() => void>()
let queue: Job[] = []
let running: Job | null = null
let worker: Worker | null = null
let broken = false
let seq = 0
let frame = 0

/** 一帧里到的结果合在一起通知 */
const announce = () => {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    for (const listener of listeners) listener()
  })
}

const pump = () => {
  if (running || queue.length === 0) return
  worker ??= spawn()
  if (!worker) {
    queue = []
    return
  }
  running = queue.shift() as Job
  const { id, text, language } = running
  worker.postMessage({ id, text, language } satisfies PaintRequest)
}

function spawn(): Worker | null {
  if (broken || typeof Worker === 'undefined') return null
  try {
    const made = new Worker(new URL('../files/highlight.worker.ts', import.meta.url), {
      type: 'module',
    })
    made.onmessage = (event: MessageEvent<PaintReply>) => {
      const reply = event.data
      const job = running
      if (!job || reply.id !== job.id) return
      if ('done' in reply) {
        running = null
        pump()
        return
      }
      for (let at = 0; at < reply.lines.length; at++) job.into[reply.from + at] = reply.lines[at]
      announce()
    }
    made.onerror = () => {
      broken = true
      stopPaint()
    }
    return made
  } catch {
    broken = true
    return null
  }
}

/** 这个文件上好色的行。第一次问的时候才排进队里 */
export function paintOf(file: FileDiff): Painted | null {
  const known = painted.get(file)
  if (known) return known
  if (!file.language || file.kind !== 'text' || broken) return null
  const sides = sideLines(file)
  const result: Painted = { old: [], next: [] }
  painted.set(file, result)
  for (const [lines, into] of [
    [sides.old, result.old],
    [sides.next, result.next],
  ] as const) {
    // 有太长的行（多半是压缩过的代码）就不上
    if (lines.length === 0 || lines.some((line) => line.length > LINE_PAINT_MAX)) continue
    queue.push({ id: ++seq, file, text: lines.join('\n'), language: file.language, into })
  }
  pump()
  return result
}

/** 上色的结果到了就叫一声 */
export function onPaint(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 不看了：排着的不要了，线程停掉。再看的时候另起 */
export function stopPaint(): void {
  // 没上完的那些忘掉：下次再问的时候重新排
  for (const job of running ? [running, ...queue] : queue) painted.delete(job.file)
  queue = []
  running = null
  worker?.terminate()
  worker = null
}
