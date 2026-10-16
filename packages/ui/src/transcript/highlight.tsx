// 代码块上色。上色库比较大，用到的时候才装载；装载好之前、以及不认识的语言，代码照原样显示。
// 上色只换颜色（见 transcript-prose.css），不换字重字形，所以上色前后每个字占的地方一样，内容不会挪动。
import { parseSpans, type SpanNode } from '@litch/core'
import { type ReactNode, useEffect, useRef, useState } from 'react'

interface Engine {
  getLanguage(name: string): unknown
  highlight(code: string, options: { language: string; ignoreIllegals: boolean }): { value: string }
}

let loading: Promise<Engine> | null = null
const engine = (): Promise<Engine> => {
  loading ??= import('highlight.js/lib/common').then((module) => module.default)
  return loading
}

/** 超过这么长的代码块不上色 */
const MAX_CHARS = 200_000
/** 还在往外流的代码块，两次上色之间至少隔这么久（毫秒） */
const MIN_GAP = 150

/** 围栏上写的语言。后面可能跟着文件名、属性之类的东西，只要开头那个词 */
export const languageOf = (info: string): string =>
  (info.trim().match(/^[A-Za-z0-9_+#.-]+/)?.[0] ?? '').toLowerCase()

export interface Painted {
  lang: string
  /** 上色时的原文。代码块还在长的话，它是现在这段文字的开头一截 */
  text: string
  nodes: SpanNode[]
}

/**
 * 给一段代码上色。返回 null 表示（还）没有上色的结果。
 * 代码块一边流一边长的时候不是每来一个字就重新上色一遍：隔一阵上一次，
 * 中间新长出来的那截先照原样接在后面（见 paint）。
 */
export function useHighlight(info: string, text: string): Painted | null {
  const lang = languageOf(info)
  const [painted, setPainted] = useState<Painted | null>(null)
  const latest = useRef({ lang, text })
  latest.current = { lang, text }
  const timer = useRef(0)
  /** 上一次上色花了多久。代码越长越慢，间隔跟着放长 */
  const cost = useRef(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      window.clearTimeout(timer.current)
      timer.current = 0
    }
  }, [])

  useEffect(() => {
    if (!lang || text.length > MAX_CHARS) return
    if ((painted?.lang === lang && painted.text === text) || timer.current) return
    const wait = painted ? Math.max(MIN_GAP, cost.current * 8) : 0
    timer.current = window.setTimeout(() => {
      void engine().then((hljs) => {
        timer.current = 0
        if (!alive.current) return
        const now = latest.current
        if (!now.lang || !hljs.getLanguage(now.lang)) return
        const started = performance.now()
        const html = hljs.highlight(now.text, { language: now.lang, ignoreIllegals: true }).value
        cost.current = performance.now() - started
        setPainted({ lang: now.lang, text: now.text, nodes: parseSpans(html) })
      })
    }, wait)
  }, [lang, text, painted])

  return painted && painted.lang === lang && text.length <= MAX_CHARS ? painted : null
}

/** 上色的结果照着画：带类名的片段和文字，不经过 HTML。文件查看器一行一行地画，也用它 */
export const renderSpans = (nodes: SpanNode[]): ReactNode[] =>
  nodes.map((node, index) =>
    typeof node === 'string' ? (
      node
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: 片段没有自己的标识，顺序就是它在代码里的位置
      <span key={index} className={node.cls}>
        {renderSpans(node.children)}
      </span>
    ),
  )

/**
 * 代码该怎么画：上过色的那一截照着色画，之后新长出来的照原样接在后面。
 * 上色的结果对不上现在的文字（不是它的开头）就整段照原样。
 */
export function paint(text: string, painted: Painted | null): ReactNode {
  if (!painted || !text.startsWith(painted.text)) return text
  return (
    <>
      {renderSpans(painted.nodes)}
      {text.slice(painted.text.length)}
    </>
  )
}
