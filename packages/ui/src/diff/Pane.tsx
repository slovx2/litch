// 差异的内容区：一个或者几个文件的差异从上到下排着，每个文件上面一条文件头（滚动时贴在顶上）。
// 只把看得见的那几块放进页面：行按 CHUNK 行一块切开，离得远的块只留一个同样高的空位。
// 不折行时每行一样高，空位的高度是准的；折行时先按一行一个行高估，画出来之后量到多少记多少。
import type { DiffEntry, FileDiff } from '@litch/core'
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { LINE_CUT } from '../files/lines.ts'
import { type DiffRow, lastLineOf, longestOf, oneSided, type Ranges, rowsOf } from './model.ts'
import { Chunk, type PickLine, type RowExtra, type Selected } from './Rows.tsx'

/** 一行多高，像素。样式里的行高要和它一样（diff.css 的 --dl） */
export const LINE = 20
const HEAD = 30
const NOTE = 44
/** 一块多少行 */
const CHUNK = 80
/** 看得见的范围上下各多画这么多像素 */
const OVERSCAN = 600

/** 展开过上下文的文件：base 是展开时的那一份（换了就作废），full 带着整个文件 */
export interface Expanded {
  base: FileDiff
  full: FileDiff
  ranges: Ranges
}

/**
 * 文件头的锚点比差异区的上边缘低多少像素（滚过顶了是负的）。
 * 不能用 offsetTop：它量的是到最近一个定位了的祖先，那是整个侧面板，上面的标签、工具栏和文件树都会算进去
 */
const belowTop = (scroller: HTMLElement, anchor: HTMLElement): number =>
  anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top

type Block =
  | { key: string; kind: 'head'; path: string; file: FileDiff }
  | { key: string; kind: 'note'; path: string; file: FileDiff }
  | { key: string; kind: 'rows'; path: string; file: FileDiff; rows: DiffRow[] }

export interface PaneProps {
  files: readonly FileDiff[]
  entries: ReadonlyMap<string, DiffEntry>
  split: boolean
  wrap: boolean
  expanded: ReadonlyMap<string, Expanded>
  /** 要滚到的文件。nonce 每要一次变一次 */
  jump: { path: string; nonce: number } | null
  /** 滚到了哪个文件 */
  onCurrent(path: string): void
  /** 点了“展开”。null：这里展不开（不是 git 的差异） */
  onReveal: ((path: string, gap: number) => void) | null
  onPick: ((path: string, ...args: Parameters<PickLine>) => void) | null
  selected: (Selected & { path: string }) | null
  renderHead(file: FileDiff, entry: DiffEntry | undefined): ReactNode
  renderNote(file: FileDiff, entry: DiffEntry | undefined): ReactNode
  /** 一行底下接着画的东西（批注） */
  extraFor: ((path: string) => RowExtra | null) | null
}

export function Pane(props: PaneProps) {
  const { files, entries, split, wrap, expanded, jump, onCurrent, onReveal, onPick, selected } =
    props
  const scroller = useRef<HTMLDivElement>(null)
  /** 量到的高度（折行时、说明块） */
  const measured = useRef(new Map<string, number>())
  const [, remeasured] = useState(0)
  const [view, setView] = useState({ top: 0, height: 0, width: 0 })

  const blocks = useMemo(() => {
    const list: Block[] = []
    for (const file of files) {
      const path = file.path
      list.push({ key: `${path}\nh`, kind: 'head', path, file })
      if (file.kind !== 'text') {
        list.push({ key: `${path}\nn`, kind: 'note', path, file })
        continue
      }
      const open = expanded.get(path)
      const shown = open && open.base === file ? open.full : file
      // 只有一边有内容的文件（新加的、删掉的）并排时也照合并的排，不白占一半的地方
      const rows = rowsOf(
        shown,
        split && !oneSided(shown),
        open && open.base === file ? open.ranges : null,
      )
      for (let at = 0; at < rows.length; at += CHUNK) {
        list.push({
          key: `${path}\nc${at}`,
          kind: 'rows',
          path,
          file: shown,
          rows: rows.slice(at, at + CHUNK),
        })
      }
    }
    return list
  }, [files, split, expanded])

  // 换了排法（并排、折行）量过的高度都不作数了
  // biome-ignore lint/correctness/useExhaustiveDependencies: 排法一变就清
  useLayoutEffect(() => {
    measured.current.clear()
  }, [split, wrap])

  const heights = blocks.map(
    (block) =>
      measured.current.get(block.key) ??
      (block.kind === 'head' ? HEAD : block.kind === 'note' ? NOTE : block.rows.length * LINE),
  )
  const tops: number[] = []
  let total = 0
  for (const height of heights) {
    tops.push(total)
    total += height
  }
  const from = view.top - OVERSCAN
  const to = view.top + view.height + OVERSCAN
  const near = (index: number): boolean =>
    (tops[index] as number) < to && (tops[index] as number) + (heights[index] as number) > from

  const measure = useCallback(() => {
    const element = scroller.current
    if (!element) return
    const top = element.scrollTop
    const height = element.clientHeight
    // 看得见的那一块多宽（不算滚动条）：文件头、说明这些横着滚时不跟着走的，照这个宽度画
    const width = element.clientWidth
    setView((before) =>
      Math.abs(before.top - top) < LINE * 4 && before.height === height && before.width === width
        ? before
        : { top, height, width },
    )
  }, [])

  // 画出来的块量一量：和估的不一样就记下（折行的时候）
  const observer = useRef<ResizeObserver | null>(null)
  if (!observer.current && typeof ResizeObserver !== 'undefined') {
    observer.current = new ResizeObserver((changes) => {
      let moved = false
      for (const change of changes) {
        const key = (change.target as HTMLElement).dataset.block
        const height = (change.target as HTMLElement).offsetHeight
        if (!key || height === 0 || measured.current.get(key) === height) continue
        measured.current.set(key, height)
        moved = true
      }
      if (moved) remeasured((n) => n + 1)
    })
  }
  const watch = useCallback((element: HTMLDivElement | null) => {
    if (!element) return
    observer.current?.observe(element)
    return () => observer.current?.unobserve(element)
  }, [])

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    measure()
    const resize = new ResizeObserver(measure)
    resize.observe(element)
    return () => resize.disconnect()
  }, [measure])
  useEffect(() => () => observer.current?.disconnect(), [])

  // 滚到了哪个文件：最后一个已经滚过顶的文件头
  const current = useRef('')
  /** 刚按要求定位到一个文件、人还没自己滚过：这时不按位置改“当前文件”（靠后的文件滚不到顶，按位置算会是别的文件） */
  const held = useRef<number | null>(null)
  const report = useCallback(() => {
    const element = scroller.current
    if (!element) return
    if (held.current !== null) {
      if (Math.abs(element.scrollTop - held.current) <= 4) return
      held.current = null
    }
    let path = ''
    for (const anchor of element.querySelectorAll<HTMLElement>('.dp-anchor')) {
      if (belowTop(element, anchor) > 4) break
      path = anchor.dataset.path ?? ''
    }
    if (path && path !== current.current) {
      current.current = path
      onCurrent(path)
    }
  }, [onCurrent])

  // 要定位到某个文件：滚到它的文件头
  const jumped = useRef(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 文件到了（blocks 变了）之后还没滚过去的也要滚
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element || !jump || jumped.current === jump.nonce) return
    for (const anchor of element.querySelectorAll<HTMLElement>('.dp-anchor')) {
      if (anchor.dataset.path !== jump.path) continue
      jumped.current = jump.nonce
      current.current = jump.path
      element.scrollTop += belowTop(element, anchor)
      held.current = element.scrollTop
      measure()
      return
    }
  }, [jump, blocks, measure])

  // 不折行时（只有合并着看才有）内容区要多宽：最长的那一行。行号那一栏多宽：最大的行号有几位
  const sizes = useMemo(() => {
    let most = 0
    let last = 0
    for (const file of files) {
      const open = expanded.get(file.path)
      const shown = open && open.base === file ? open.full : file
      const size = longestOf(shown)
      most = Math.max(most, size.old, size.next)
      last = Math.max(last, lastLineOf(shown))
    }
    return { longest: Math.min(most, LINE_CUT), digits: Math.max(2, String(last).length) }
  }, [files, expanded])

  const style = {
    '--dp-one': `${sizes.longest + 2}ch`,
    '--dnum': `calc(${sizes.digits}ch + 16px)`,
    '--dp-w': view.width > 0 ? `${view.width}px` : '100%',
  } as CSSProperties

  return (
    <div
      className="dp"
      ref={scroller}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 要能用键盘滚
      tabIndex={0}
      data-layout={split ? 'split' : 'unified'}
      data-wrap={wrap ? 'on' : 'off'}
      data-files={files.length}
      onScroll={() => {
        flushSync(measure)
        report()
      }}
      style={style}
    >
      <div className="dp-pad" style={{ minHeight: total }}>
        {blocks.map((block, index) => {
          const entry = entries.get(block.path)
          if (block.kind === 'head') {
            return [
              <div key={`${block.key}a`} className="dp-anchor" data-path={block.path} />,
              <div key={block.key} className="dp-head" data-path={block.path}>
                {props.renderHead(block.file, entry)}
              </div>,
            ]
          }
          if (block.kind === 'note') {
            return (
              <div
                key={block.key}
                className="dp-note"
                data-path={block.path}
                data-kind={block.file.kind}
              >
                {props.renderNote(block.file, entry)}
              </div>
            )
          }
          if (!near(index)) {
            return <div key={block.key} className="dp-gap" style={{ height: heights[index] }} />
          }
          return (
            <div
              key={block.key}
              className="dp-rows"
              data-block={block.key}
              data-path={block.path}
              ref={watch}
            >
              <Chunk
                path={block.path}
                file={block.file}
                rows={block.rows}
                onPick={onPick}
                onReveal={onReveal}
                selected={selected?.path === block.path ? selected : null}
                extraFor={props.extraFor}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
