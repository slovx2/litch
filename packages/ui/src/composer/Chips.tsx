// 输入区里随消息带的东西（图片之外的）：一个个小片，每片能拿掉。
// 片上只放一眼要看的（记号、名字）；带着的文字那一片能点开，浮层里看开头一段，能放回正文、能拿掉；
// 提到的文件只是一个路径，鼠标移上去看得到完整的。
// 选中回答加的评论每条一片，排在最前面（CommentChip）。
import type { MessageExtra } from '@litch/core'
import { type ReactNode, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Close, Icon, Snippet, Spark } from '../app/icons.tsx'
import { usePopover } from '../app/popover.ts'
import { CommentEditor } from '../transcript/comments/Editor.tsx'
import type { DraftComment } from './drafts.ts'
import { extraLabel, lineCount } from './extras.ts'

type TextExtra = Extract<MessageExtra, { kind: 'text' }>

interface ChipProps {
  extra: MessageExtra
  onRemove(): void
  /** 把这段文字放回正文。带着的文字才用得着 */
  onInline(): void
}

/** 浮层里最多画这么多个字符：整段都画的话几十万字会卡，看个开头够判断是不是贴对了 */
const PEEK_CHARS = 20_000

/** 一片上写的字。贴进来的文字没有名字，说它有几行 */
export function useExtraLabel(): (extra: MessageExtra) => string {
  const t = useT()
  return (extra) =>
    extraLabel(extra) ??
    t('chip.text.pasted', {
      n: lineCount(extra.kind === 'text' ? extra.text : '').toLocaleString(t.lang),
    })
}

export function ExtraChip({ extra, onRemove, onInline }: ChipProps) {
  const t = useT()
  const label = useExtraLabel()(extra)
  const remove = (
    <button
      type="button"
      className="cmp-chip-x"
      title={t('composer.extra.remove', { name: label })}
      aria-label={t('composer.extra.remove', { name: label })}
      onClick={onRemove}
    >
      <Close />
    </button>
  )
  if (extra.kind === 'text') {
    return (
      <TextChip extra={extra} label={label} onRemove={onRemove} onInline={onInline}>
        {remove}
      </TextChip>
    )
  }
  // 片上只写名字；提到的文件在哪（完整的路径）鼠标移上去看
  const about =
    extra.kind === 'file' ? `${t('chip.file')} · ${extra.path}` : `${t('chip.skill')} ${label}`
  return (
    <li className="cmp-chip" data-kind={extra.kind} title={about}>
      {extra.kind === 'file' ? <Icon name="file" /> : <Spark />}
      <span className="ell">{label}</span>
      {remove}
    </li>
  )
}

interface TextChipProps {
  extra: TextExtra
  label: string
  children: ReactNode
  onRemove(): void
  onInline(): void
}

function TextChip({ extra, label, children, onRemove, onInline }: TextChipProps) {
  const t = useT()
  const { open, setOpen, close, root, trigger, pop, onKeyDown } = usePopover()
  const count = (n: number) => n.toLocaleString(t.lang)
  const size = t('chip.text.size', {
    lines: count(lineCount(extra.text)),
    chars: count(extra.text.length),
  })
  const rest = extra.text.length - PEEK_CHARS
  return (
    <li className="cmp-chip" data-kind="text">
      {/* 这一层不占位置，只是给“点到外面收起”圈个范围：片和它的浮层算里面 */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 键盘事件是从里面的按钮和那段文字冒上来的 */}
      <div
        className="cmp-chip-box"
        ref={root}
        // 浮层里只有 Esc 归它管（收起，不让外面的请求卡片当成拒绝）；上下键留给那段文字自己滚
        onKeyDown={(event) => {
          if (event.key === 'Escape') onKeyDown(event)
        }}
      >
        <button
          type="button"
          ref={trigger}
          className="cmp-chip-open"
          aria-haspopup="dialog"
          aria-expanded={open}
          title={`${t('chip.text')} · ${size}`}
          onClick={() => setOpen(!open)}
        >
          <Snippet />
          <span className="ell">{label}</span>
        </button>
        {children}
        {open ? (
          <div className="peek" ref={pop} role="dialog" aria-label={label}>
            <div className="peek-head">
              <Snippet />
              <b className="ell">{extra.name ?? t('chip.text')}</b>
              <span className="peek-size">{size}</span>
              <button
                type="button"
                className="ibtn"
                title={t('peek.close')}
                aria-label={t('peek.close')}
                onClick={() => close(true)}
              >
                <Close />
              </button>
            </div>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: 要能拿到焦点，键盘才滚得动这段文字 */}
            <pre className="peek-body" tabIndex={0}>
              {rest > 0 ? extra.text.slice(0, PEEK_CHARS) : extra.text}
            </pre>
            {rest > 0 ? (
              <div className="peek-more">{t('peek.more', { n: count(rest) })}</div>
            ) : null}
            <div className="peek-foot">
              <span className="grow">{t('peek.note')}</span>
              <button
                type="button"
                className="btn"
                data-act="inline"
                onClick={() => {
                  close(false)
                  onInline()
                }}
              >
                {t('peek.inline')}
              </button>
              <button
                type="button"
                className="btn ghost"
                data-act="remove"
                onClick={() => {
                  close(false)
                  onRemove()
                }}
              >
                {t('peek.remove')}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </li>
  )
}

interface CommentChipProps {
  comment: DraftComment
  /** 第几条（从 1 开始），回答里的 [N] 指的就是它 */
  n: number
  onSave(note: string): void
  onRemove(): void
  /** 只把这一条直接发出去 */
  onSend(note: string): void
  /** 回合在跑、这时发出去会排队（不是插进回合）：按钮写“排队” */
  queue: boolean
  /** 滚到原文、闪一下。不在已有的会话里（新建页）不给 */
  onLocate?: (() => void) | undefined
}

/** 一条评论：编号、引用的开头、评论的开头。点开在片旁边弹编辑框（改、删、定位原文），× 删掉 */
export function CommentChip({
  comment,
  n,
  queue,
  onSave,
  onRemove,
  onSend,
  onLocate,
}: CommentChipProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const chip = useRef<HTMLLIElement>(null)
  const quote = comment.quote.replace(/\s+/g, ' ')
  const note = comment.note.trim().replace(/\s+/g, ' ')
  return (
    <li className="cmp-chip cmt-chip" data-kind="comment" data-comment={comment.id} ref={chip}>
      <button
        type="button"
        className="cmp-chip-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={note ? `${quote}\n— ${note}` : quote}
        onClick={() => setOpen(!open)}
      >
        <span className="cmt-chip-n">{n}</span>
        <span className="cmt-chip-quote">{quote}</span>
        {note ? <span className="cmt-chip-note">{note}</span> : null}
      </button>
      <button
        type="button"
        className="cmp-chip-x"
        title={t('comment.remove', { n })}
        aria-label={t('comment.remove', { n })}
        onClick={onRemove}
      >
        <Close />
      </button>
      {open ? (
        <CommentEditor
          mode="edit"
          quote={comment.quote}
          note={comment.note}
          side="above"
          queue={queue}
          anchor={() => chip.current?.getBoundingClientRect() ?? null}
          owner={() => chip.current}
          onCancel={() => setOpen(false)}
          onSave={(next) => {
            setOpen(false)
            onSave(next)
          }}
          onDelete={() => {
            setOpen(false)
            onRemove()
          }}
          onSend={(next) => {
            setOpen(false)
            onSend(next)
          }}
          {...(onLocate ? { onLocate } : {})}
        />
      ) : null}
    </li>
  )
}
