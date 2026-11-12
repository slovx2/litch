// 问号小图标：鼠标停在上面、或所在的按钮拿到键盘焦点时，旁边浮出一句说明。
// 说明自己是顶层浮层（popover），菜单这类顶层浮层里也盖得住；它一直在文档里，
// 所在按钮用 aria-describedby 指向它，读屏念完按钮名字接着念说明（说明本身 aria-hidden，不混进按钮名字）。
// 问号本身不可点、不抢焦点。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Help } from './icons.tsx'

/** 说明和问号之间、说明和窗口边沿之间留的空 */
const GAP = 6
const EDGE = 8

export function HelpTip({ id, text }: { id: string; text: string }) {
  const icon = useRef<HTMLSpanElement>(null)
  const tip = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState(false)

  // 所在的按钮拿到键盘焦点（:focus-visible）时也浮出来，失焦收起
  useEffect(() => {
    const owner = icon.current?.closest('button')
    if (!owner) return
    const focus = () => setShown(owner.matches(':focus-visible'))
    const blur = () => setShown(false)
    owner.addEventListener('focus', focus)
    owner.addEventListener('blur', blur)
    return () => {
      owner.removeEventListener('focus', focus)
      owner.removeEventListener('blur', blur)
    }
  }, [])

  // 默认放在问号右边、顶端对齐；右边放不下就放到左边，上下不出窗口
  useLayoutEffect(() => {
    const box = tip.current
    const mark = icon.current
    if (!box || !mark) return
    if (!shown) {
      if (box.matches(':popover-open')) box.hidePopover()
      return
    }
    if (!box.matches(':popover-open')) box.showPopover()
    const at = mark.getBoundingClientRect()
    const width = box.offsetWidth
    const right = at.right + GAP
    const left = right + width > window.innerWidth - EDGE ? at.left - GAP - width : right
    const top = Math.min(at.top - GAP, window.innerHeight - box.offsetHeight - EDGE)
    box.style.left = `${Math.max(EDGE, left)}px`
    box.style.top = `${Math.max(EDGE, top)}px`
  }, [shown])

  return (
    <>
      <span
        ref={icon}
        className="help-q"
        aria-hidden="true"
        onPointerEnter={() => setShown(true)}
        onPointerLeave={() => setShown(false)}
      >
        <Help />
      </span>
      <span ref={tip} id={id} className="help-tip" popover="manual" aria-hidden="true">
        {text}
      </span>
    </>
  )
}
