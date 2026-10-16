// 只读地显示一个文件的文字：带行号，只画看得见的那些行，按语言上色（上色在工作线程里做，见 painter.ts）。
// 上色只换颜色，不换字重字形：上色前后每个字占的地方一样，颜色到了内容不会挪动。
import type { SpanNode } from '@litch/core'
import {
  type CSSProperties,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react'
import { useT } from '../app/appearance.ts'
import { renderSpans } from '../transcript/highlight.tsx'
import { cutLine, digitsOf, LINE_CUT, longestLine, splitLines } from './lines.ts'
import { type PaintMode, paintFile } from './painter.ts'
import { rememberViewScroll, viewScrollOf } from './state.ts'
import { useVirtual } from './virtual.ts'

/** 一行多高，像素。样式里的行高要和它一样（files.css 的 --fv-line） */
export const LINE_HEIGHT = 20

interface Paint {
  /** 上好色的行，按行号放。还没到的那些是空着的，照原样显示 */
  lines: (SpanNode[] | undefined)[]
  /** pending：还在上 */
  mode: PaintMode | 'pending'
}

/** 给这份文字上色。结果一批一批到，到一批画一批（一帧里到的合在一起画） */
function usePaint(text: string, language: string | null, longest: number): Paint {
  const paint = useRef<Paint>({ lines: [], mode: 'pending' })
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const lines: (SpanNode[] | undefined)[] = []
    paint.current = { lines, mode: 'pending' }
    let frame = 0
    const later = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        redraw()
      })
    }
    const cancel = paintFile(text, language, longest, {
      lines(from, batch) {
        for (let at = 0; at < batch.length; at++) lines[from + at] = batch[at]
        later()
      },
      done(mode) {
        paint.current = { lines, mode }
        later()
      },
    })
    later()
    return () => {
      cancel()
      cancelAnimationFrame(frame)
    }
  }, [text, language, longest])
  return paint.current
}

const Line = memo(function Line({
  number,
  text,
  nodes,
  marked,
}: {
  number: number
  text: string
  nodes: SpanNode[] | undefined
  /** 是要定位到的那一行 */
  marked: boolean
}) {
  const t = useT()
  const cut = cutLine(text)
  return (
    <div className={marked ? 'cl hl' : 'cl'} data-line={number}>
      <span className="ln">{number}</span>
      <span className="lc">
        {nodes && cut.hidden === 0 ? renderSpans(nodes) : cut.text}
        {cut.hidden > 0 ? (
          <span className="cl-cut">{t('files.view.lineCut', { n: cut.hidden })}</span>
        ) : null}
      </span>
    </div>
  )
})

/** 各个文件已经滚过去的那一次定位。回到一个文件时，定位过的不再滚回去，留在上次看的地方 */
const jumped = new Map<string, number>()
const JUMPED_MAX = 500

const markJumped = (id: string, jump: number) => {
  jumped.delete(id)
  jumped.set(id, jump)
  if (jumped.size <= JUMPED_MAX) return
  const oldest = jumped.keys().next().value
  if (oldest !== undefined) jumped.delete(oldest)
}

export function CodeView({
  uiKey,
  path,
  text,
  language,
  line,
  jump,
}: {
  /** 哪一棵树（记滚动位置用） */
  uiKey: string
  path: string
  text: string
  language: string | null
  /** 要定位到的行（从 1 起） */
  line: number | null
  /** 每要求定位一次就变一次 */
  jump: number
}) {
  const lines = useMemo(() => splitLines(text), [text])
  const longest = useMemo(() => longestLine(lines), [lines])
  const paint = usePaint(text, language, longest)
  const virtual = useVirtual(lines.length, LINE_HEIGHT, 30)
  const { scroller, show } = virtual
  const id = `${uiKey}\n${path}`
  const target = line === null ? null : Math.min(Math.max(line, 1), lines.length)

  // 打开这个文件、或者又要求定位了一次：有没滚过去的定位就去那一行；刚打开又没有要定位的，回到上次看的地方
  const opened = useRef(false)
  const { onScroll, sync } = virtual
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const first = !opened.current
    opened.current = true
    if (target !== null && jumped.get(id) !== jump) {
      markJumped(id, jump)
      show(target - 1, 'lead')
      return
    }
    if (!first) return
    element.scrollTop = viewScrollOf(uiKey, path)
    sync()
  }, [scroller, show, sync, id, uiKey, path, target, jump])

  const digits = digitsOf(lines.length)
  return (
    <div
      className="fv-code"
      ref={scroller}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 要能用键盘滚
      tabIndex={0}
      data-lines={lines.length}
      data-paint={paint.mode}
      data-language={language ?? ''}
      onScroll={() => {
        onScroll()
        const element = scroller.current
        if (element) rememberViewScroll(uiKey, path, element.scrollTop)
      }}
      style={{ '--fv-digits': digits } as CSSProperties}
    >
      <div
        className="fv-pad"
        style={{
          height: lines.length * LINE_HEIGHT,
          // 宽度按最长的一行估：画的只是看得见的行，不估的话横向的滚动条会跟着滚到哪一行忽长忽短
          minWidth: `calc(${Math.min(longest, LINE_CUT) + digits + 4}ch)`,
        }}
      >
        <div
          className="fv-win"
          style={{ transform: `translateY(${virtual.first * LINE_HEIGHT}px)` }}
        >
          {lines.slice(virtual.first, virtual.last).map((content, offset) => {
            const number = virtual.first + offset + 1
            return (
              <Line
                key={number}
                number={number}
                text={content}
                nodes={paint.lines[number - 1]}
                marked={number === target}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
