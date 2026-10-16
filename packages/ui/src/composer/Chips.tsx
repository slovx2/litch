// 输入区里随消息带的东西（图片之外的）：一个个小片，每片能拿掉。
// 片上只放一眼要看的（记号、名字）；带着的文字那一片能点开，浮层里看开头一段，能放回正文、能拿掉；
// 提到的文件只是一个路径，鼠标移上去看得到完整的。
import type { MessageExtra } from '@litch/core'
import type { ReactNode } from 'react'
import { useT } from '../app/appearance.ts'
import { Close, Icon, Snippet, Spark } from '../app/icons.tsx'
import { usePopover } from '../app/popover.ts'
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
