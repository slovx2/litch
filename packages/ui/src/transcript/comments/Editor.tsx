// 写评论的那个小框：上面是引用的原文（最多三行，多的折起），下面写评论。
// 新加的从选区旁弹出；改已有的从输入框上的片、原文上的记号弹出，多“定位原文”“删除”两样。
// 回车：加进（存好）；Shift+回车换行；⌘/Ctrl+回车：只把这一条直接发出去；Esc 或点外面：不要。
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../app/appearance.ts'

export interface EditorProps {
  quote: string
  note?: string
  /** new：新加的；edit：改已有的 */
  mode: 'new' | 'edit'
  /** 贴着什么放：它现在在屏幕上的位置。滚动、窗口变了会再问 */
  anchor(): DOMRect | null
  /** 放在它下面还是上面。下面放不下自动换到上面，反过来也一样 */
  side: 'below' | 'above'
  /** 点到这个里面不算“点外面”（点开它的那一片：再点一下是收起，交给那一片自己管） */
  owner?: () => Element | null
  onSave(note: string): void
  onSend(note: string): void
  onCancel(): void
  onDelete?(): void
  onLocate?(): void
}

const WIDTH = 340
const GAP = 6
const MARGIN = 8

const mac = () => /Mac|iPhone|iPad/.test(navigator.platform)

export function CommentEditor(props: EditorProps) {
  const { quote, mode, side, onSave, onSend, onCancel } = props
  const t = useT()
  const [note, setNote] = useState(props.note ?? '')
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const [unfolded, setUnfolded] = useState(false)
  const [foldable, setFoldable] = useState(false)
  const card = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const quoteBox = useRef<HTMLDivElement>(null)
  // 回调每次都是新的：放进引用里，事件监听不用跟着重挂
  const latest = useRef(props)
  latest.current = props

  // 贴着锚点放：横向和它的左边对齐、不出窗口；竖向按 side 放，放不下换一边
  useLayoutEffect(() => {
    const place = () => {
      const box = latest.current.anchor()
      const element = card.current
      if (!box || !element) return
      const height = element.offsetHeight
      const width = Math.min(WIDTH, window.innerWidth - MARGIN * 2)
      const left = Math.max(MARGIN, Math.min(box.left, window.innerWidth - width - MARGIN))
      const below = box.bottom + GAP
      const above = box.top - GAP - height
      const roomBelow = below + height <= window.innerHeight - MARGIN
      const roomAbove = above >= MARGIN
      const top =
        side === 'below'
          ? roomBelow || !roomAbove
            ? below
            : above
          : roomAbove || !roomBelow
            ? above
            : below
      setPlace({ left, top: Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN)) })
    }
    place()
    const observer = new ResizeObserver(place)
    if (card.current) observer.observe(card.current)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [side])

  // 放好位置（看得见了）才能拿到焦点：第一次画出来时还藏着
  const placed = place !== null
  useEffect(() => {
    const area = input.current
    if (!area || !placed) return
    area.focus({ preventScroll: true })
    area.setSelectionRange(area.value.length, area.value.length)
  }, [placed])

  // 点到外面就不要了
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (card.current?.contains(target)) return
      if (latest.current.owner?.()?.contains(target)) return
      latest.current.onCancel()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [])

  // 引用超过三行才给“展开”
  // biome-ignore lint/correctness/useExhaustiveDependencies: 引用变了要重新量
  useLayoutEffect(() => {
    const box = quoteBox.current
    if (box && !unfolded) setFoldable(box.scrollHeight > box.clientHeight + 1)
  }, [quote, unfolded])

  // 输入框跟着内容长高
  // biome-ignore lint/correctness/useExhaustiveDependencies: 字变了要重新量
  useLayoutEffect(() => {
    const area = input.current
    if (!area) return
    area.style.height = 'auto'
    area.style.height = `${Math.min(area.scrollHeight, 160)}px`
  }, [note])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      // 只关自己，别让外面的 Esc（拒绝审批）跟着动
      event.preventDefault()
      event.stopPropagation()
      onCancel()
      return
    }
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    if (event.metaKey || event.ctrlKey) onSend(note)
    else onSave(note)
  }

  const sendKey = mac() ? '⌘' : 'Ctrl+'
  return createPortal(
    <div
      ref={card}
      className="cmt-edit"
      role="dialog"
      aria-label={t(mode === 'new' ? 'comment.add' : 'comment.edit')}
      data-mode={mode}
      style={
        place
          ? { left: place.left, top: place.top }
          : { left: -10_000, top: 0, visibility: 'hidden' }
      }
    >
      <div
        ref={quoteBox}
        className={unfolded ? 'cmt-edit-quote' : 'cmt-edit-quote fold'}
        title={unfolded ? undefined : quote}
      >
        {quote}
      </div>
      {foldable || unfolded ? (
        <button type="button" className="mini cmt-edit-more" onClick={() => setUnfolded(!unfolded)}>
          {t(unfolded ? 'comment.quote.less' : 'comment.quote.more')}
        </button>
      ) : null}
      <textarea
        ref={input}
        className="cmt-edit-text"
        rows={2}
        value={note}
        placeholder={t('comment.placeholder')}
        aria-label={t('comment.placeholder')}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="cmt-edit-foot">
        {props.onLocate ? (
          <button type="button" className="mini" data-act="locate" onClick={props.onLocate}>
            {t('comment.locate')}
          </button>
        ) : null}
        {props.onDelete ? (
          <button type="button" className="mini" data-act="delete" onClick={props.onDelete}>
            {t('comment.delete')}
          </button>
        ) : null}
        <span className="grow cmt-edit-hint">{t('comment.keys', { send: `${sendKey}↵` })}</span>
        <button
          type="button"
          className="btn ghost"
          data-act="send"
          title={t('comment.send.note')}
          onClick={() => onSend(note)}
        >
          {t('comment.send')}
        </button>
        <button type="button" className="btn primary" data-act="save" onClick={() => onSave(note)}>
          {t(mode === 'new' ? 'comment.save.new' : 'comment.save')}
        </button>
      </div>
    </div>,
    document.body,
  )
}
