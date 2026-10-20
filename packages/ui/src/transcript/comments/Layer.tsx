// 对话区里评论的那一层：在回答里选中一段时选区上方的小浮层（评论、复制），从那里打开的编辑框；
// 还挂在输入框上的评论在原文上的淡底色（CSS Custom Highlight，不改页面结构）和段尾的编号小记号。
// 挂在对话内容（.tr）里，位置按它算：滚动时跟着走，不用重算。
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../app/appearance.ts'
import { Bubble, Icon } from '../../app/icons.tsx'
import { useServices } from '../../app/services.tsx'
import type { DraftComment } from '../../composer/drafts.ts'
import { CommentEditor } from './Editor.tsx'
import { originRange } from './locate.ts'
import {
  addComment,
  commentKey,
  MAX_COMMENTS,
  newCommentId,
  removeComment,
  sendComment,
  updateComment,
  useDraftComments,
} from './model.ts'
import { ITEM_ATTR, itemRoot, offsetOf, plainOf, rootByQuote, textNodes } from './text-range.ts'

/** 原文上的淡底色 */
const MARK = 'litch-comment'
/** 正在写的那一条（还没加进去）的底色 */
const PENDING = 'litch-comment-pending'

/** 选中的、能加评论的一段 */
interface Pick {
  range: Range
  itemId: string
  quote: string
  start: number
  end: number
  raw: string
}

/** 原文上的一个编号记号，位置相对这一层 */
interface Badge {
  id: string
  n: number
  x: number
  y: number
}

type Editing = { kind: 'new'; pick: Pick } | { kind: 'edit'; id: string }

/**
 * 现在的选区能不能加评论：起点在某条回答的正文里、选到了字。跨了几条只取开头那条里的部分，
 * 选区也跟着缩到那一条里（看得见到底评论的是哪一段）
 */
function readSelection(scope: Element): Pick | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  let range = selection.getRangeAt(0)
  const startNode = range.startContainer
  const startEl = startNode instanceof Element ? startNode : startNode.parentElement
  const root = startEl?.closest(`[${ITEM_ATTR}]`)
  if (!root || !scope.contains(root)) return null
  const itemId = root.getAttribute(ITEM_ATTR)
  if (!itemId) return null
  if (!root.contains(range.endContainer)) {
    range = range.cloneRange()
    range.setEnd(root, root.childNodes.length)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  const quote = selection.toString().trim()
  if (!quote) return null
  const nodes = textNodes(root)
  const start = offsetOf(nodes, range.startContainer, range.startOffset, root)
  const end = offsetOf(nodes, range.endContainer, range.endOffset, root)
  const raw = plainOf(nodes).slice(start, end)
  if (!raw.trim()) return null
  return { range, itemId, quote, start, end, raw }
}

const highlights = () => (typeof CSS !== 'undefined' ? CSS.highlights : undefined)

interface LayerProps {
  deviceId: string
  sessionId: string
}

export const CommentLayer = memo(function CommentLayer({ deviceId, sessionId }: LayerProps) {
  const t = useT()
  const { channel } = useServices()
  const key = commentKey(deviceId, sessionId)
  const comments = useDraftComments(key)
  const layer = useRef<HTMLDivElement>(null)
  const [pick, setPick] = useState<Pick | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [badges, setBadges] = useState<Badge[]>([])
  const [copied, setCopied] = useState(false)
  /** 滚动、窗口变了：浮层跟着选区挪 */
  const [, setTick] = useState(0)
  const badgeEls = useRef(new Map<string, HTMLButtonElement>())
  const full = comments.length >= MAX_COMMENTS

  const scope = useCallback(() => layer.current?.parentElement ?? null, [])

  // 松开鼠标时看一眼选区；选区没了浮层也收起
  useEffect(() => {
    const onUp = (event: MouseEvent) => {
      if (event.button !== 0) return
      const root = scope()
      if (!root) return
      // 点在浮层、编辑框上不算
      if (event.target instanceof Element && event.target.closest('.cmt-pop, .cmt-edit')) return
      // 等这次点击把选区定下来再看
      window.setTimeout(() => {
        setCopied(false)
        setPick(readSelection(root))
      }, 0)
    }
    const onChange = () => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) setPick(null)
    }
    document.addEventListener('mouseup', onUp)
    document.addEventListener('selectionchange', onChange)
    return () => {
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('selectionchange', onChange)
    }
  }, [scope])

  // 浮层开着时跟着滚动挪
  useEffect(() => {
    if (!pick) return
    const move = () => setTick((n) => n + 1)
    document.addEventListener('scroll', move, true)
    window.addEventListener('resize', move)
    return () => {
      document.removeEventListener('scroll', move, true)
      window.removeEventListener('resize', move)
    }
  }, [pick])

  // 原文上的底色和记号：评论变了、对话里的东西变了（流式输出、展开收起）、尺寸变了都重画一遍
  useLayoutEffect(() => {
    const root = scope()
    const own = layer.current
    const registry = highlights()
    if (!root || !own) return
    const pending = editing?.kind === 'new' ? editing.pick.range : null
    if (comments.length === 0 && !pending) {
      registry?.delete(MARK)
      registry?.delete(PENDING)
      setBadges((current) => (current.length === 0 ? current : []))
      return
    }
    let frame = 0
    const paint = () => {
      frame = 0
      const base = own.getBoundingClientRect()
      const ranges: Range[] = []
      const next: Badge[] = []
      comments.forEach((comment, index) => {
        const item =
          itemRoot(root, comment.itemId) ?? rootByQuote(root, comment.raw || comment.quote)
        const range = item ? originRange(item, { deviceId, sessionId, ...comment }) : null
        if (!range) return
        ranges.push(range)
        const rects = range.getClientRects()
        const last = rects[rects.length - 1]
        if (!last) return
        next.push({
          id: comment.id,
          n: index + 1,
          x: Math.round(last.right - base.left),
          y: Math.round(last.top - base.top),
        })
      })
      if (registry) {
        if (ranges.length > 0) registry.set(MARK, new Highlight(...ranges))
        else registry.delete(MARK)
        if (pending) registry.set(PENDING, new Highlight(pending))
        else registry.delete(PENDING)
      }
      setBadges((current) =>
        current.length === next.length &&
        current.every(
          (badge, at) =>
            badge.id === next[at]?.id &&
            badge.n === next[at]?.n &&
            badge.x === next[at]?.x &&
            badge.y === next[at]?.y,
        )
          ? current
          : next,
      )
    }
    const later = () => {
      if (!frame) frame = requestAnimationFrame(paint)
    }
    paint()
    const mutations = new MutationObserver((records) => {
      // 自己这一层的变化不算
      if (records.every((record) => own.contains(record.target))) return
      later()
    })
    mutations.observe(root, { childList: true, subtree: true, characterData: true })
    const sizes = new ResizeObserver(later)
    sizes.observe(root)
    return () => {
      cancelAnimationFrame(frame)
      mutations.disconnect()
      sizes.disconnect()
    }
  }, [comments, editing, scope, deviceId, sessionId])

  // 换会话、关掉对话时把底色拿掉
  useEffect(
    () => () => {
      highlights()?.delete(MARK)
      highlights()?.delete(PENDING)
    },
    [],
  )

  const clearSelection = () => window.getSelection()?.removeAllRanges()

  const startNew = () => {
    if (!pick || full) return
    setEditing({ kind: 'new', pick })
    setPick(null)
  }

  const copy = () => {
    if (!pick) return
    navigator.clipboard.writeText(pick.quote).then(
      () => setCopied(true),
      () => {},
    )
  }

  const draftOf = (from: Pick, note: string): DraftComment => ({
    id: newCommentId(),
    itemId: from.itemId,
    quote: from.quote,
    note,
    start: from.start,
    end: from.end,
    raw: from.raw,
  })

  const send = (comment: DraftComment) =>
    // 没发出去就留在输入框上面，不丢
    sendComment(channel, deviceId, sessionId, comment).catch(() => addComment(key, comment))

  const editor = (() => {
    if (!editing) return null
    if (editing.kind === 'new') {
      const from = editing.pick
      return (
        <CommentEditor
          key="new"
          mode="new"
          quote={from.quote}
          side="below"
          anchor={() => from.range.getBoundingClientRect()}
          onCancel={() => setEditing(null)}
          onSave={(note) => {
            addComment(key, draftOf(from, note))
            setEditing(null)
            clearSelection()
          }}
          onSend={(note) => {
            setEditing(null)
            clearSelection()
            void send(draftOf(from, note))
          }}
        />
      )
    }
    const comment = comments.find((each) => each.id === editing.id)
    if (!comment) return null
    return (
      <CommentEditor
        key={comment.id}
        mode="edit"
        quote={comment.quote}
        note={comment.note}
        side="below"
        anchor={() => badgeEls.current.get(comment.id)?.getBoundingClientRect() ?? null}
        owner={() => badgeEls.current.get(comment.id) ?? null}
        onCancel={() => setEditing(null)}
        onSave={(note) => {
          updateComment(key, comment.id, note)
          setEditing(null)
        }}
        onDelete={() => {
          removeComment(key, comment.id)
          setEditing(null)
        }}
        onSend={(note) => {
          removeComment(key, comment.id)
          setEditing(null)
          void send({ ...comment, note })
        }}
      />
    )
  })()

  const box = pick?.range.getBoundingClientRect()
  return (
    <>
      <div className="cmt-marks" ref={layer} aria-hidden={badges.length === 0 || undefined}>
        {badges.map((badge) => (
          <button
            key={badge.id}
            type="button"
            className="cmt-badge"
            data-comment={badge.id}
            ref={(element) => {
              if (element) badgeEls.current.set(badge.id, element)
              else badgeEls.current.delete(badge.id)
            }}
            style={{ left: badge.x, top: badge.y }}
            title={t('comment.badge', { n: badge.n })}
            aria-label={t('comment.badge', { n: badge.n })}
            aria-expanded={editing?.kind === 'edit' && editing.id === badge.id}
            onClick={() =>
              setEditing((current) =>
                current?.kind === 'edit' && current.id === badge.id
                  ? null
                  : { kind: 'edit', id: badge.id },
              )
            }
          >
            {badge.n}
          </button>
        ))}
      </div>
      {pick && box && box.width + box.height > 0
        ? createPortal(
            <div
              className="cmt-pop"
              role="toolbar"
              aria-label={t('comment.pop')}
              style={{ left: Math.max(8, box.left), top: Math.max(8, box.top - 6) }}
              // 按下时不让选区丢掉，键盘照常点里面的按钮
              onMouseDown={(event) => event.preventDefault()}
            >
              <button
                type="button"
                data-act="comment"
                disabled={full}
                title={full ? t('comment.full', { max: MAX_COMMENTS }) : undefined}
                onClick={startNew}
              >
                <Bubble />
                {t('comment.add')}
              </button>
              <button type="button" data-act="copy" onClick={copy}>
                <Icon name="copy" />
                {t(copied ? 'code.copied' : 'code.copy')}
              </button>
            </div>,
            document.body,
          )
        : null}
      {editor}
    </>
  )
})
