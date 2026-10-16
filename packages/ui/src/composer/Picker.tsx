import { type ReactNode, useEffect, useState } from 'react'
import { Caret } from '../app/icons.tsx'
import { usePopover } from '../app/popover.ts'

export interface PickerOption {
  id: string
  title: string
  note?: string
  /** 标题前面的小记号（设备的线色、工作区挑过的颜色）。按钮上和选项里都带着 */
  lead?: ReactNode
  /** 现在选不了：列在那里让人看得到，旁边的说明里写着为什么 */
  disabled?: boolean
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
}

/** 底栏上的一个选择器：一个显示当前值的按钮，点开是往上弹的选项列表 */
export function Picker({ kind, label, value, options, onPick }: PickerProps) {
  /** 正在等用户确认的那一项 */
  const [asking, setAsking] = useState<PickerOption | null>(null)
  const { open, setOpen, close, root, trigger, pop, onKeyDown } = usePopover(asking)
  const current = options.find((option) => option.id === value)

  // 收起之后，下次点开回到列表那一屏
  useEffect(() => {
    if (!open) setAsking(null)
  }, [open])

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
              {options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  className="pick-opt"
                  aria-selected={!option.action && option.id === value}
                  aria-disabled={option.disabled ? 'true' : undefined}
                  data-option={option.id}
                  data-action={option.action ? '' : undefined}
                  onClick={() => pick(option)}
                >
                  <b>
                    {option.lead}
                    {option.title}
                  </b>
                  {option.note ? <span>{option.note}</span> : null}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
