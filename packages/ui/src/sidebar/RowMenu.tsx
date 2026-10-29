import { type RefObject, useEffect, useImperativeHandle, useLayoutEffect, useState } from 'react'
import { wireStyle } from '../app/device.ts'
import { More } from '../app/icons.tsx'
import { usePopover } from '../app/popover.ts'

/** 让这一行别处的操作（在行上点右键）也能把这份菜单叫出来 */
export interface RowMenuHandle {
  /** 在窗口里的这个位置弹出来 */
  openAt(x: number, y: number): void
}

/** 菜单和窗口边沿之间留的空 */
const EDGE = 8

export interface RowAction {
  id: string
  title: string
  /** 做之前要再确认一次（删除这类找不回来的事） */
  confirm?: { title: string; note: string; yes: string; no: string }
  /** 点了之后还要再挑一个（移到哪个工作区）：换成一屏选项，挑中的那一项的标识随 onAction 给出去 */
  choices?: { title: string; back: string; options: RowChoice[] }
  /** 现在做不了：淡下去。给了字的，下面一行写为什么 */
  disabled?: string | true
}

export interface RowChoice {
  id: string
  title: string
  /** 名字前面的色块用哪根线色。不给就没有色块 */
  wire?: string | null
}

interface RowMenuProps {
  label: string
  actions: RowAction[]
  onAction(id: string, choice?: string): void
  handle?: RefObject<RowMenuHandle | null>
}

/** 侧栏一行行尾的“更多”：点开是这一行能做的事。在行上点右键出的也是这一份，只是弹在鼠标那里 */
export function RowMenu({ label, actions, onAction, handle }: RowMenuProps) {
  const [asking, setAsking] = useState<RowAction | null>(null)
  /** 正在“再挑一个”的那一项 */
  const [choosing, setChoosing] = useState<RowAction | null>(null)
  /** 弹在哪：右键是鼠标那里，按钮是按钮底下、右边对齐（end：x 是右边沿，量出宽度后换成左边沿）。收起时是 null */
  const [spot, setSpot] = useState<{ x: number; y: number; end?: boolean } | null>(null)
  const { open, setOpen, close, root, trigger, pop, onKeyDown } = usePopover(asking ?? choosing)

  useImperativeHandle(
    handle,
    () => ({
      openAt(x, y) {
        setAsking(null)
        setChoosing(null)
        setSpot({ x, y })
        setOpen(true)
      },
    }),
    [setOpen],
  )

  useEffect(() => {
    if (open) return
    setAsking(null)
    setChoosing(null)
    setSpot(null)
  }, [open])

  // 菜单放进顶层：离线设备下面那一块整体淡下去，留在行里的菜单会跟着淡、伸出侧栏的部分被主区盖住。
  // 靠近窗口边沿时往回挪，整块都留在窗口里。换成确认那一屏会变大，再量一次
  // biome-ignore lint/correctness/useExhaustiveDependencies: 换了一屏要重新量
  useLayoutEffect(() => {
    const box = pop.current
    if (!open || !spot || !box) return
    const left = spot.end ? spot.x - box.offsetWidth : spot.x
    const x = Math.max(EDGE, Math.min(left, window.innerWidth - box.offsetWidth - EDGE))
    const y = Math.max(EDGE, Math.min(spot.y, window.innerHeight - box.offsetHeight - EDGE))
    if (spot.end || x !== spot.x || y !== spot.y) setSpot({ x, y })
  }, [open, spot, asking, choosing, pop])

  // 弹出来的菜单不跟着行走：这一行所在的地方（侧栏）一滚、窗口一失焦就收起。别处滚（对话区跟着流式输出往下走）不算
  const floating = open && spot !== null
  useEffect(() => {
    if (!floating) return
    const gone = (event: Event) => {
      if (
        event.type === 'blur' ||
        (event.target instanceof Node && event.target.contains(root.current))
      )
        setOpen(false)
    }
    window.addEventListener('scroll', gone, true)
    window.addEventListener('blur', gone)
    return () => {
      window.removeEventListener('scroll', gone, true)
      window.removeEventListener('blur', gone)
    }
  }, [floating, setOpen, root])

  const run = (action: RowAction, confirmed = false) => {
    if (action.disabled !== undefined) return
    if (action.choices) {
      setChoosing(action)
      return
    }
    if (action.confirm && !confirmed) {
      setAsking(action)
      return
    }
    close(false)
    onAction(action.id)
  }
  const choose = (action: RowAction, choice: string) => {
    close(false)
    onAction(action.id, choice)
  }

  return (
    <div className={open ? 'row-more on' : 'row-more'} ref={root}>
      <button
        ref={trigger}
        type="button"
        className="ibtn"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          const box = trigger.current?.getBoundingClientRect()
          if (open || !box) setOpen(false)
          else {
            setSpot({ x: box.right, y: box.bottom + 4, end: true })
            setOpen(true)
          }
        }}
      >
        <More />
      </button>
      {open ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: 键盘事件是从里面的按钮冒上来的
        <div
          className={spot ? 'pick-pop down at' : 'pick-pop down'}
          style={spot ? { left: spot.x, top: spot.y } : undefined}
          popover={spot ? 'manual' : undefined}
          ref={(box) => {
            pop.current = box
            // 挂上就进顶层：要赶在 usePopover 往里落焦点之前，没弹出来的顶层浮层不显示、焦点落不进去
            if (box?.hasAttribute('popover') && !box.matches(':popover-open')) box.showPopover()
          }}
          onKeyDown={onKeyDown}
        >
          {asking?.confirm ? (
            <div className="pick-ask">
              <b>{asking.confirm.title}</b>
              <span>{asking.confirm.note}</span>
              <div className="pick-ask-actions">
                <button type="button" className="btn ghost" onClick={() => setAsking(null)}>
                  {asking.confirm.no}
                </button>
                <button type="button" className="btn danger" onClick={() => run(asking, true)}>
                  {asking.confirm.yes}
                </button>
              </div>
            </div>
          ) : choosing?.choices ? (
            <div role="menu" aria-label={choosing.choices.title} className="pick-list">
              <div className="pick-title">{choosing.choices.title}</div>
              {choosing.choices.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="menuitem"
                  className="pick-opt pick-choice"
                  data-choice={option.id}
                  onClick={() => choose(choosing, option.id)}
                >
                  <b>
                    {option.wire ? <i className="ws-dot" style={wireStyle(option.wire)} /> : null}
                    {option.title}
                  </b>
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                className="pick-opt pick-back"
                onClick={() => setChoosing(null)}
              >
                <span>{choosing.choices.back}</span>
              </button>
            </div>
          ) : (
            <div role="menu" aria-label={label} className="pick-list">
              {actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  className="pick-opt"
                  data-action={action.id}
                  aria-disabled={action.disabled !== undefined || undefined}
                  onClick={() => run(action)}
                >
                  <b>{action.title}</b>
                  {typeof action.disabled === 'string' ? <span>{action.disabled}</span> : null}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
