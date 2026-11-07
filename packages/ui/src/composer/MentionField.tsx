// 输入框里提到的会话画成片（逻辑在 mention-field.ts）。
// 输入框还是 textarea：字、光标、选区、输入法、原生撤销都归它，发出去和存草稿的也还是 @[标题]。
// 有片时 textarea 的字变透明，下面垫一层同样排版的字（MentionMirror），对上了的 @[标题] 在这一层画成片：
// 片和原文占一样宽（@[ 的位置放图标、] 留空），所以光标、选区、换行和下面那层严丝合缝。
// useMentionGuard 管光标不落进片里、退格整片删、复制粘贴带上是哪个会话、悬停写全称。
import {
  type ClipboardEvent,
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from 'react'
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import {
  CLIPBOARD_TYPE,
  chipsWithin,
  chipToDelete,
  clipboardMentions,
  type DraftMention,
  type MentionRange,
  snapSelection,
} from './mention-field.ts'

/** 照 textarea 的排版抄到垫着的那一层上：字体、行高、字距、内边距一样，换行才一样 */
const COPIED = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textTransform',
  'tabSize',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
] as const

/**
 * 用输入框自己的编辑把字换成 next：进原生撤销栈，Cmd+Z 撤得回来。只换前后不一样的那一段，
 * 换完光标落在 caret。浏览器不支持时返回 false，调用方自己改值
 */
export function editNative(area: HTMLTextAreaElement, next: string, caret: number): boolean {
  const now = area.value
  let head = 0
  while (head < now.length && head < next.length && now[head] === next[head]) head += 1
  let tail = 0
  while (
    tail < now.length - head &&
    tail < next.length - head &&
    now[now.length - 1 - tail] === next[next.length - 1 - tail]
  )
    tail += 1
  const piece = next.slice(head, next.length - tail)
  area.focus()
  area.setSelectionRange(head, now.length - tail)
  const done =
    typeof document.execCommand === 'function' &&
    (piece ? document.execCommand('insertText', false, piece) : document.execCommand('delete'))
  if (!done || area.value !== next) return false
  area.setSelectionRange(caret, caret)
  return true
}

/** 垫在 textarea 下面的那一层：普通的字照原样，提到的会话画成片。读屏读 textarea，这一层不读 */
export function MentionMirror({
  area,
  text,
  ranges,
  describedBy,
}: {
  area: RefObject<HTMLTextAreaElement | null>
  text: string
  ranges: readonly MentionRange[]
  describedBy: string
}) {
  const t = useT()
  const mirror = useRef<HTMLDivElement>(null)

  // 排版、尺寸、滚动跟着 textarea：皮肤、字号一换，或者框长高了、出了滚动条，都要再抄一遍
  useLayoutEffect(() => {
    const field = area.current
    const layer = mirror.current
    if (!field || !layer) return
    const copy = () => {
      const style = getComputedStyle(field)
      for (const name of COPIED) layer.style[name] = style[name]
      layer.style.width = `${field.clientWidth}px`
      layer.style.height = `${field.clientHeight}px`
      layer.scrollTop = field.scrollTop
    }
    copy()
    const watch = new ResizeObserver(copy)
    watch.observe(field)
    const follow = () => {
      layer.scrollTop = field.scrollTop
    }
    field.addEventListener('scroll', follow)
    return () => {
      watch.disconnect()
      field.removeEventListener('scroll', follow)
    }
  }, [area])
  // 字换了之后滚动位置可能跟着变（打到最后一行、粘贴一大段）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 字变了才对一次
  useLayoutEffect(() => {
    if (mirror.current && area.current) mirror.current.scrollTop = area.current.scrollTop
  }, [text])

  const parts: ReactNode[] = []
  let at = 0
  for (const range of ranges) {
    if (range.start > at)
      parts.push(<Fragment key={`t${at}`}>{text.slice(at, range.start)}</Fragment>)
    parts.push(
      <span key={`m${range.start}`} className="men-chip" data-mention={range.threadId}>
        <span className="men-sig">
          <Icon name="note" small />
          @[
        </span>
        {range.title}
        <span className="men-sig">]</span>
      </span>,
    )
    at = range.end
  }
  // 末尾是换行时补一个字，最后那一空行才占得住高度
  parts.push(<Fragment key={`t${at}`}>{`${text.slice(at)}\u200b`}</Fragment>)
  return (
    <>
      <div ref={mirror} className="men-mirror" aria-hidden="true">
        {parts}
      </div>
      <span id={describedBy} className="men-desc">
        {ranges.map((range) => t('mention.chip', { title: range.title })).join(t('list.comma'))}
      </span>
    </>
  )
}

/**
 * 输入框上和片有关的几样操作。onKeyDown 处理了返回真；host.replace 在浏览器不让用原生编辑时改值。
 * remember 收下从剪贴板带进来的会话（同一台设备上复制的片）
 */
export function useMentionGuard({
  area,
  ranges,
  deviceId,
  replace,
  remember,
}: {
  area: RefObject<HTMLTextAreaElement | null>
  ranges: readonly MentionRange[]
  deviceId: string
  replace(next: string, caret: number): void
  remember?(mentions: DraftMention[]): void
}) {
  const t = useT()
  const describedBy = useId()
  const previous = useRef<{ start: number; end: number } | null>(null)
  const composing = useRef(false)

  const latest = useRef(ranges)
  latest.current = ranges

  const onSelect = () => {
    const field = area.current
    if (!field) return
    const now = { start: field.selectionStart, end: field.selectionEnd }
    if (!composing.current) {
      const snapped = snapSelection(latest.current, now, previous.current)
      if (snapped) {
        field.setSelectionRange(snapped.start, snapped.end, field.selectionDirection)
        previous.current = snapped
        return
      }
    }
    previous.current = now
  }

  // React 的 onSelect 只在键盘、鼠标之后看选区；别处用代码挪的光标（setSelectionRange）靠原生的 selectionchange
  // biome-ignore lint/correctness/useExhaustiveDependencies: onSelect 每次都读 latest，挂一次就够
  useEffect(() => {
    const field = area.current
    if (!field) return
    const follow = () => {
      if (document.activeElement === field) onSelect()
    }
    field.addEventListener('selectionchange', follow)
    document.addEventListener('selectionchange', follow)
    return () => {
      field.removeEventListener('selectionchange', follow)
      document.removeEventListener('selectionchange', follow)
    }
  }, [area])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.key !== 'Backspace' && event.key !== 'Delete') return false
    if (event.metaKey || event.nativeEvent.isComposing) return false
    const field = event.currentTarget
    const chip = chipToDelete(
      ranges,
      { start: field.selectionStart, end: field.selectionEnd },
      event.key,
    )
    if (!chip) return false
    event.preventDefault()
    const next = field.value.slice(0, chip.start) + field.value.slice(chip.end)
    if (!editNative(field, next, chip.start)) replace(next, chip.start)
    return true
  }

  /** 复制、剪切：选中的字里有整片的，随文字带上是哪几个会话，贴回同一台设备的输入框还是片 */
  const carry = (event: ClipboardEvent<HTMLTextAreaElement>, cut: boolean) => {
    const field = event.currentTarget
    const { selectionStart: start, selectionEnd: end } = field
    const chips = chipsWithin(ranges, start, end)
    if (chips.length === 0) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', field.value.slice(start, end))
    event.clipboardData.setData(
      CLIPBOARD_TYPE,
      JSON.stringify({ device: deviceId, mentions: chips }),
    )
    if (!cut) return
    const next = field.value.slice(0, start) + field.value.slice(end)
    if (!editNative(field, next, start)) replace(next, start)
  }

  /** 悬停在片上：textarea 的提示写这个会话的全称（垫着的那层不接鼠标，按位置找） */
  const onMouseMove = (event: MouseEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget
    if (ranges.length === 0) {
      if (field.title) field.removeAttribute('title')
      return
    }
    const layer = field.parentElement?.querySelector('.men-mirror')
    const chips = layer ? [...layer.querySelectorAll<HTMLElement>('.men-chip')] : []
    const over = chips.findIndex((chip) =>
      [...chip.getClientRects()].some(
        (rect) =>
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom,
      ),
    )
    const range = over >= 0 ? ranges[over] : undefined
    const tip = range ? t('mention.chip', { title: range.title }) : ''
    if (tip) field.title = tip
    else if (field.title) field.removeAttribute('title')
  }

  return {
    describedBy,
    /** 交给 textarea 的属性和事件（onKeyDown 由调用方先调 guard.onKeyDown） */
    props: {
      'aria-describedby': ranges.length > 0 ? describedBy : undefined,
      onCopy: (event: ClipboardEvent<HTMLTextAreaElement>) => carry(event, false),
      onCut: (event: ClipboardEvent<HTMLTextAreaElement>) => carry(event, true),
      onMouseMove,
      onCompositionStart: () => {
        composing.current = true
      },
      onCompositionEnd: () => {
        composing.current = false
      },
    },
    onSelect,
    onKeyDown,
    /** 粘贴时先看剪贴板里有没有随字带来的会话 */
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const raw = event.clipboardData.getData(CLIPBOARD_TYPE)
      if (!raw || !remember) return
      const mentions = clipboardMentions(raw, deviceId)
      if (mentions.length > 0) remember(mentions)
    },
  }
}
