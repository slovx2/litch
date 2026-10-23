import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Caret } from '../app/icons.tsx'
import { usePopover } from '../app/popover.ts'
import { matchOptions, SEARCH_FROM } from './picker-search.ts'

export interface PickerOption {
  id: string
  title: string
  /** 标题下面的一行小字。只放“为什么选不了”、主机名、路径这类分辨用的，不放解释这一项是什么的 */
  note?: string
  /** 解释这一项是什么的话：不占地方，鼠标停在上面才出来 */
  hint?: string
  /** 标题前面的小记号（设备的线色、工作区挑过的颜色）。按钮上和选项里都带着 */
  lead?: ReactNode
  /** 现在选不了：列在那里让人看得到，旁边的说明里写着为什么 */
  disabled?: boolean
  /** 说明那一行右边的一个小按钮（选不了的那一项“去安装”）：点了先收起列表再做 */
  noteAction?: { label: string; run(): void }
  /** 选它之前要再确认一次 */
  confirm?: { title: string; note: string; yes: string; no: string }
  /** 这一项不是一个值，是一件事（“添加…”）：和上面的值隔开一条线，从来不算选中的 */
  action?: boolean
}

interface PickerProps {
  /** 这是哪一个选择器。写在元素上，样式和自检按它找 */
  kind?: string
  /** 这个选择器选的是什么，给读屏用，也是按钮的提示 */
  label: string
  /** 当前的值。选项里没有它的时候照原样显示 */
  value: string | null
  options: PickerOption[]
  onPick(id: string): void
  /**
   * 选项多的时候（SEARCH_FROM 个起）在列表顶上放一个筛选框，这是框里的提示语。
   * 不给就没有筛选框：只有几项的选择器用不着（模型清单有的 harness 能列出上百个）
   */
  search?: string
}

/** 底栏上的一个选择器：一个显示当前值的按钮，点开是往上弹的选项列表 */
export function Picker({ kind, label, value, options, onPick, search }: PickerProps) {
  const t = useT()
  /** 正在等用户确认的那一项 */
  const [asking, setAsking] = useState<PickerOption | null>(null)
  const [query, setQuery] = useState('')
  const { open, setOpen, close, root, trigger, pop, onKeyDown } = usePopover(asking)
  const field = useRef<HTMLInputElement>(null)
  const current = options.find((option) => option.id === value)
  const searching = search !== undefined && options.length >= SEARCH_FROM
  const shown = searching ? matchOptions(options, query) : options

  // 收起之后，下次点开回到列表那一屏，筛选框是空的
  useEffect(() => {
    if (!open) {
      setAsking(null)
      setQuery('')
    }
  }, [open])

  // 有筛选框的：点开时焦点落在框里（浮层自己先把焦点给了选中的那一项，这里接着改），
  // 选中的那一项滚进看得见的地方
  useLayoutEffect(() => {
    if (!open || !searching || asking) return
    pop.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({
      block: 'nearest',
    })
    field.current?.focus()
  }, [open, searching, asking, pop])

  const pick = (option: PickerOption, confirmed = false) => {
    if (option.disabled) return
    if (option.confirm && !confirmed && option.id !== value) {
      setAsking(option)
      return
    }
    close(true)
    if (option.id !== value) onPick(option.id)
  }

  return (
    <div className="pick" ref={root} data-kind={kind}>
      <button
        ref={trigger}
        type="button"
        className="pick-btn"
        title={label}
        aria-label={`${label}：${current?.title ?? value ?? ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {current?.lead}
        <span className="ell">{current?.title ?? value ?? label}</span>
        <Caret />
      </button>
      {open ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: 键盘事件是从里面的按钮冒上来的
        <div className="pick-pop" ref={pop} onKeyDown={onKeyDown}>
          {asking?.confirm ? (
            <div className="pick-ask">
              <b>{asking.confirm.title}</b>
              <span>{asking.confirm.note}</span>
              <div className="pick-ask-actions">
                <button type="button" className="btn ghost" onClick={() => setAsking(null)}>
                  {asking.confirm.no}
                </button>
                <button type="button" className="btn danger" onClick={() => pick(asking, true)}>
                  {asking.confirm.yes}
                </button>
              </div>
            </div>
          ) : (
            <div role="listbox" aria-label={label} className="pick-list">
              {searching ? (
                <input
                  ref={field}
                  className="pick-search"
                  type="search"
                  value={query}
                  placeholder={search}
                  aria-label={search}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    // 回车：筛出来的头一个能选的
                    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                    event.preventDefault()
                    const first = shown.find((option) => !option.disabled && !option.action)
                    if (first) pick(first)
                  }}
                />
              ) : null}
              {searching && shown.length === 0 ? (
                <div className="pick-none">{t('picker.noMatch')}</div>
              ) : null}
              {shown.map((option) => {
                const row = (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    className="pick-opt"
                    aria-selected={!option.action && option.id === value}
                    aria-disabled={option.disabled ? 'true' : undefined}
                    data-option={option.id}
                    data-action={option.action ? '' : undefined}
                    title={option.hint}
                    onClick={() => pick(option)}
                  >
                    <b>
                      {option.lead}
                      {option.title}
                    </b>
                    {option.note ? <span>{option.note}</span> : null}
                  </button>
                )
                const action = option.noteAction
                if (!action) return row
                // 按钮不能套在选项的按钮里：并排放着，压在说明那一行的右边
                return (
                  <div key={option.id} className="pick-opt-wrap">
                    {row}
                    <button
                      type="button"
                      className="pick-note-action"
                      data-note-action={option.id}
                      onClick={() => {
                        close(true)
                        action.run()
                      }}
                    >
                      {action.label}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
