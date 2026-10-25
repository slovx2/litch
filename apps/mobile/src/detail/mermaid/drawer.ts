// 画图的排队和缓存（不依赖 RN，单测 test/mermaid.test.mjs）。画是在藏在应用根上的一个 WebView 里画的（MermaidHost.tsx），
// 卡片（MermaidCard.tsx）进了屏幕才来要，离开屏幕就撤回还没开始画的；同一张图（外观、卡片大小、原文都一样）只画一次。
//
// - 卡片 watch 自己那张图的键（一直听着），进了屏幕才 request（排队要画）；结果都经 watch 回去。
// - 一次只交给页面一张，后来要的先画：快速滑过很多张时，最后停下来看见的那几张先出来。
// - 画好的和画不出来的（语法错）都按键记着，最多 KEEP 张，久没用的先丢。超时的不记，页面重开一次。
// - 没有要画的了，过 IDLE_MS 把页面撤掉（mermaid 装进来要几十 MB），下次要画再开。
import type { MermaidLook } from './look'

/** 卡片里放图的地方：宽高（dp）、像素密度、小图最多放大几倍 */
export interface DrawBox {
  width: number
  height: number
  scale: number
  max: number
}

export type Drawing =
  /** png 是 data: 地址；width、height 是缩略图在卡片里该显示的大小（dp），等比缩过、不超过卡片 */
  { svg: string; png: string; width: number; height: number } | { error: string }

export interface DrawJob {
  key: string
  source: string
  config: MermaidLook['config']
  box: DrawBox
}

export type ToPage = {
  t: 'draw'
  id: number
  source: string
  config: MermaidLook['config']
  box: DrawBox
}

export type FromPage =
  | { t: 'ready' }
  | { t: 'drawn'; id: number; svg: string; png: string; width: number; height: number }
  | { t: 'failed'; id: number; reason: string }
  | { t: 'error'; message: string }

/** 页面该不该开着；generation 变了就重开一个（上一个卡住了） */
export interface HostState {
  wanted: boolean
  generation: number
}

const KEEP = 40
const TIMEOUT_MS = 20_000
const IDLE_MS = 60_000

/** 画太久、没等到结果时给的原因（卡片换成自己的说法） */
export const TIMED_OUT = 'timeout'

export const drawKey = (look: string, box: DrawBox, source: string): string =>
  `${look}|${box.width}x${box.height}@${box.scale}|${source}`

type Listener = (drawing: Drawing) => void

export class MermaidDrawer {
  private readonly cache = new Map<string, Drawing>()
  /** 等着某一张图的卡片（不管它现在要不要画：滑出屏幕的卡片也想知道别人替它画好了） */
  private readonly watchers = new Map<string, Set<Listener>>()
  /** 还没交给页面的，和有几张卡片在要。按要的先后排（Map 记着插入顺序） */
  private readonly waiting = new Map<string, { job: DrawJob; demand: number }>()
  private current: { id: number; job: DrawJob; timer: ReturnType<typeof setTimeout> } | null = null
  private send: ((message: ToPage) => void) | null = null
  private serial = 0
  private state: HostState = { wanted: false, generation: 0 }
  private readonly hostListeners = new Set<() => void>()
  private idle: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly options: { keep?: number; timeoutMs?: number; idleMs?: number } = {},
  ) {}

  /** 画过的（用一次算一次新） */
  peek(key: string): Drawing | undefined {
    const known = this.cache.get(key)
    if (known) {
      this.cache.delete(key)
      this.cache.set(key, known)
    }
    return known
  }

  /** 这张图画好了（或画不出来、超时了）告诉我。只听，不排队 */
  watch(key: string, listener: Listener): () => void {
    let set = this.watchers.get(key)
    if (!set) this.watchers.set(key, (set = new Set()))
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0 && this.watchers.get(key) === set) this.watchers.delete(key)
    }
  }

  /** 要画这张图（结果经 watch 拿）。返回的函数撤回：没有卡片要了、还没开始画的就不画了 */
  request(job: DrawJob): () => void {
    if (this.cache.has(job.key)) return () => {}
    if (this.current?.job.key !== job.key) {
      const entry = this.waiting.get(job.key) ?? { job, demand: 0 }
      entry.demand += 1
      // 后要的排到最后（先画）
      this.waiting.delete(job.key)
      this.waiting.set(job.key, entry)
      this.wake()
    }
    let withdrawn = false
    return () => {
      if (withdrawn) return
      withdrawn = true
      const entry = this.waiting.get(job.key)
      if (entry && --entry.demand <= 0) this.waiting.delete(job.key)
      this.settle()
    }
  }

  // 下面几个给 MermaidHost 用

  readonly subscribeHost = (listener: () => void): (() => void) => {
    this.hostListeners.add(listener)
    return () => this.hostListeners.delete(listener)
  }

  readonly hostState = (): HostState => this.state

  /** 页面说装好了：之后经 send 交给它 */
  pageReady(send: (message: ToPage) => void): void {
    this.send = send
    this.next()
  }

  /** 页面没了（撤掉、重开）：正在画的那张放回去排着 */
  pageGone(): void {
    this.send = null
    const current = this.current
    if (!current) return
    clearTimeout(current.timer)
    this.current = null
    if (this.watchers.has(current.job.key))
      this.waiting.set(current.job.key, { job: current.job, demand: 1 })
  }

  /** 页面的渲染进程没了：重开一个 */
  pageCrashed(): void {
    this.pageGone()
    this.setState({ wanted: true, generation: this.state.generation + 1 })
  }

  receive(message: FromPage): void {
    if (message.t !== 'drawn' && message.t !== 'failed') return
    const current = this.current
    if (!current || current.id !== message.id) return
    clearTimeout(current.timer)
    this.current = null
    const drawing: Drawing =
      message.t === 'drawn'
        ? { svg: message.svg, png: message.png, width: message.width, height: message.height }
        : { error: message.reason }
    this.remember(current.job.key, drawing)
    this.tell(current.job.key, drawing)
    this.next()
  }

  private tell(key: string, drawing: Drawing): void {
    for (const listener of [...(this.watchers.get(key) ?? [])]) listener(drawing)
  }

  private remember(key: string, drawing: Drawing): void {
    this.cache.set(key, drawing)
    const keep = this.options.keep ?? KEEP
    while (this.cache.size > keep) this.cache.delete(this.cache.keys().next().value as string)
  }

  private next(): void {
    const key = [...this.waiting.keys()].at(-1)
    const entry = key === undefined ? undefined : this.waiting.get(key)
    if (this.current || !this.send || key === undefined || !entry) {
      this.settle()
      return
    }
    this.waiting.delete(key)
    const id = ++this.serial
    const timer = setTimeout(() => this.timedOut(id), this.options.timeoutMs ?? TIMEOUT_MS)
    this.current = { id, job: entry.job, timer }
    const { source, config, box } = entry.job
    this.send({ t: 'draw', id, source, config, box })
  }

  /** 一张画太久（多半是图太大或卡住了）：这一张算画不出来、不记，页面重开，接着画别的 */
  private timedOut(id: number): void {
    const current = this.current
    if (!current || current.id !== id) return
    this.current = null
    this.send = null
    this.tell(current.job.key, { error: TIMED_OUT })
    this.setState({ wanted: true, generation: this.state.generation + 1 })
  }

  /** 有活要页面开着 */
  private wake(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    if (!this.state.wanted) this.setState({ ...this.state, wanted: true })
    this.next()
  }

  /** 没活了：过一会儿撤掉页面 */
  private settle(): void {
    if (this.current || this.waiting.size > 0 || !this.state.wanted || this.idle) return
    this.idle = setTimeout(() => {
      this.idle = null
      if (this.current || this.waiting.size > 0) return
      this.setState({ ...this.state, wanted: false })
    }, this.options.idleMs ?? IDLE_MS)
  }

  private setState(next: HostState): void {
    this.state = next
    for (const listener of this.hostListeners) listener()
  }
}

/** 整个应用一份：画过的图在会话之间、页面进出之间都留着 */
export const drawer = new MermaidDrawer()
