// 收起和展开都用这一个：一个带箭头的按钮，箭头的朝向跟着 aria-expanded 走（base.css 里 .caret-ic 的规则，
// 和侧栏工作区那一行是同一个箭头）。它只管“点一下”，开没开由用它的地方记着——只记在内存里，不落盘。
import { type ReactNode, useEffect, useState } from 'react'
import { Caret } from './icons.tsx'

interface FoldProps {
  open: boolean
  onToggle(): void
  /** 它管着的那一块内容的 id。收起的时候那一块不在页面上 */
  controls: string
  className?: string
  /** 鼠标停上去的提示。比如现在为什么收不起来 */
  title?: string | undefined
  children: ReactNode
}

export function Fold({ open, onToggle, controls, className, title, children }: FoldProps) {
  return (
    <button
      type="button"
      className={className ? `fold ${className}` : 'fold'}
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      title={title}
      onClick={onToggle}
    >
      <Caret />
      {children}
    </button>
  )
}

/**
 * 一块能收起的内容开没开，默认收着。平时听用户的；里面有不能藏起来的东西时（没保存的改动、没起来的入口）
 * 一定开着，点收起也不合上。因此打开过之后就留着：那件事了结的一瞬间自己合上，人会找不着刚才在看的东西。
 * 只有一种情况会跟着合上：被迫开着的时候用户自己点过收起——那是他要的，等那件事了结就照办
 */
export function useFold(forced: boolean): { open: boolean; toggle(): void } {
  const [picked, setPicked] = useState(false)
  useEffect(() => {
    if (forced) setPicked(true)
  }, [forced])
  const open = picked || forced
  return { open, toggle: () => setPicked(!open) }
}
