import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * 一个按钮点开一块浮层（选择器、行上的菜单）要管的几件事：
 * 点到外面收起；Esc 收起并把焦点还给按钮；上下键在里面的按钮之间走；弹出来时焦点落进去。
 * screen 换了（比如从列表换成确认那一屏）会重新落一次焦点。
 */
export function usePopover(screen: unknown = null) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  // biome-ignore lint/correctness/useExhaustiveDependencies: 换了一屏就要重新落焦点
  useLayoutEffect(() => {
    if (!open) return
    const items = pop.current?.querySelectorAll<HTMLElement>('button')
    const chosen = pop.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    ;(chosen ?? items?.[0])?.focus()
  }, [open, screen])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      // 只收起自己，别让外面的 Esc 处理（比如拒绝审批）也跟着动
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
    if (!step && event.key !== 'Home' && event.key !== 'End') return
    const items = [...(pop.current?.querySelectorAll<HTMLElement>('button') ?? [])]
    if (items.length === 0) return
    event.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (at + (step ?? 0) + items.length) % items.length
    items[next]?.focus()
  }

  return { open, setOpen, close, root, trigger, pop, onKeyDown }
}
