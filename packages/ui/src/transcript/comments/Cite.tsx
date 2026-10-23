// 回答里的 [N]：只认紧跟在带评论的用户消息之后、同一回合里助手说的话。画成小记号“评论 N”，
// 鼠标移上去看引用和评论，点了跳到原文闪一下（原文不在了就滚到那张评论卡片、把它展开）。编号超出条数的照原文。
import {
  keys,
  type ParsedComment,
  type ParsedComments,
  parseComments,
  type UserMessageItem,
} from '@litch/core'
import {
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../app/appearance.ts'
import { useKey, useServices } from '../../app/services.tsx'
import { flash } from '../../tree/proposals.ts'
import { Prose } from '../FileLinks.tsx'
import { MentionScope } from '../SessionMentions.tsx'
import { setToggle } from '../state.ts'
import { cardMark, cardToggle } from './Cards.tsx'
import { revealOrigin } from './locate.ts'

interface CiteValue {
  deviceId: string
  sessionId: string
  /** 带评论的那条用户消息 */
  userId: string
  comments: ParsedComment[]
}

const CiteContext = createContext<CiteValue | null>(null)

/** 先粗看一眼有没有 [数字]，绝大多数文字不用往下拆 */
export const HAS_CITE = /\[\d{1,2}\]/

/** 一条用户消息的文字认成评论；不是带评论的就是 null。认一遍的结果按文字记着，几个地方共用 */
const parsed = new Map<string, ParsedComments | null>()
export function commentsOf(text: string): ParsedComments | null {
  if (!text.startsWith('<litch-comments>')) return null
  let found = parsed.get(text)
  if (found === undefined) {
    found = parseComments(text)
    if (parsed.size > 200) parsed.clear()
    parsed.set(text, found)
  }
  return found
}

interface ScopeProps {
  deviceId: string
  sessionId: string
  /** 这一块前面最近的那条用户消息。没有就不认 [N] */
  userId: string | undefined
  children: ReactNode
}

/**
 * 回合里跟在一条用户消息后面的那些块：那条消息带评论的话，里面的 [N] 认作指向它的评论；
 * 提到了会话的，里面对得上的 @[标题] 画成会话片（SessionMentions.tsx 的 MentionScope）
 */
export function CiteScope({ deviceId, sessionId, userId, children }: ScopeProps) {
  const item = useKey<UserMessageItem>(keys.item(deviceId, sessionId, userId ?? ''))
  const text = item?.kind === 'userMessage' ? item.text : ''
  const comments = commentsOf(text)?.comments ?? null
  const value = useMemo(
    () => (comments && userId ? { deviceId, sessionId, userId, comments } : null),
    [comments, deviceId, sessionId, userId],
  )
  return (
    <CiteContext.Provider value={value}>
      <MentionScope
        deviceId={deviceId}
        sessions={item?.kind === 'userMessage' ? item.sessions : undefined}
      >
        {children}
      </MentionScope>
    </CiteContext.Provider>
  )
}

/** 回答里的一段字：里面的 [N] 对得上评论就画成记号，别的照常 */
export function CiteText({ text }: { text: string }) {
  const scope = useContext(CiteContext)
  const plain = (part: string, key: number) =>
    part.includes('/') ? <Prose key={key} text={part} /> : <Fragment key={key}>{part}</Fragment>
  if (!scope) return plain(text, 0)
  const out: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(/\[(\d{1,2})\]/g)) {
    const comment = scope.comments[Number(match[1]) - 1]
    if (!comment) continue
    if (match.index > last) out.push(plain(text.slice(last, match.index), out.length))
    out.push(<Cite key={out.length} scope={scope} comment={comment} />)
    last = match.index + match[0].length
  }
  if (last < text.length) out.push(plain(text.slice(last), out.length))
  return out
}

function Cite({ scope, comment }: { scope: CiteValue; comment: ParsedComment }) {
  const t = useT()
  const { store } = useServices().replica
  const button = useRef<HTMLButtonElement>(null)
  const [peek, setPeek] = useState<DOMRect | null>(null)
  const { deviceId, sessionId, userId } = scope

  const open = () => {
    setPeek(null)
    void revealOrigin(store, { deviceId, sessionId, quote: comment.quote, before: userId }).then(
      (found) => {
        if (found) return
        // 原文不在了：滚到那张评论卡片，把它展开
        setToggle(`${deviceId}:${sessionId}`, cardToggle(userId, comment.index), true)
        const card = document.querySelector(
          `.main .tr [data-ucmt="${CSS.escape(cardMark(userId, comment.index))}"]`,
        )
        if (!card) return
        card.scrollIntoView({ block: 'center' })
        flash(card)
      },
    )
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className="cmt-cite"
        data-cite={comment.index}
        aria-label={t('comment.cite.label', { n: comment.index })}
        onMouseEnter={() => setPeek(button.current?.getBoundingClientRect() ?? null)}
        onMouseLeave={() => setPeek(null)}
        onFocus={() => setPeek(button.current?.getBoundingClientRect() ?? null)}
        onBlur={() => setPeek(null)}
        onClick={open}
      >
        {t('comment.cite', { n: comment.index })}
      </button>
      {peek
        ? createPortal(
            <div
              className="cmt-peek"
              role="tooltip"
              // 下面放不下就放到记号上面
              data-up={peek.bottom > window.innerHeight - 180 || undefined}
              style={{
                left: Math.max(8, Math.min(peek.left, window.innerWidth - 328)),
                top: peek.bottom > window.innerHeight - 180 ? peek.top - 6 : peek.bottom + 6,
              }}
            >
              <span className="cmt-peek-quote">{comment.quote}</span>
              {comment.note ? <span className="cmt-peek-note">{comment.note}</span> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
