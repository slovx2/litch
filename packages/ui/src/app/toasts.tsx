// 短暂的提示：从主区顶上浮出来，说一句刚才发生了什么，可以带一个动作（比如“撤销”）。
// 几秒后自己消失；鼠标或者键盘焦点在上面时不消失，离开之后重新计时。
// 同一个标识的提示再来一次是换掉内容、重新计时，不会叠出第二条。
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Translator } from '../i18n/index.ts'
import { useT } from './appearance.ts'
import { Close } from './icons.tsx'

export interface Toast {
  id: string
  /** 提示上的字。显示的时候才按当前语言说，改了语言跟着变 */
  text(t: Translator): string
  /** err：没做成的事，用出错的颜色 */
  tone?: 'plain' | 'err'
  action?: { label(t: Translator): string; run(): void }
  /** 多久之后自己消失（毫秒）。0：一直留到用户关掉 */
  lifeMs: number
  /** 提示自己消失了或者被关掉了。点了上面的动作不算 */
  onGone?(): void
}

interface Shown extends Toast {
  /** 每次换内容都换一个，计时跟着重新开始 */
  stamp: number
}

let list: readonly Shown[] = []
let stamp = 0
const listeners = new Set<() => void>()

const publish = (next: readonly Shown[]) => {
  list = next
  for (const listener of listeners) listener()
}

/** 出一条提示。标识已经在的话换掉内容，位置不变 */
export function showToast(toast: Toast): void {
  const entry: Shown = { ...toast, stamp: ++stamp }
  const index = list.findIndex((shown) => shown.id === toast.id)
  publish(index < 0 ? [...list, entry] : list.with(index, entry))
}

/** 收起一条提示。gone 为真表示它是自己消失或者被关掉的，要告诉出提示的一方 */
export function dismissToast(id: string, gone = false): void {
  const entry = list.find((shown) => shown.id === id)
  if (!entry) return
  publish(list.filter((shown) => shown !== entry))
  if (gone) entry.onGone?.()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function ToastRow({ toast }: { toast: Shown }) {
  const t = useT()
  /** 鼠标在上面、焦点在里面：这两种时候不计时 */
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const held = hovered || focused
  const { id, lifeMs, stamp: version } = toast

  // biome-ignore lint/correctness/useExhaustiveDependencies: 内容换了（version 变了）要重新计时
  useEffect(() => {
    if (held || lifeMs <= 0) return
    const timer = window.setTimeout(() => dismissToast(id, true), lifeMs)
    return () => window.clearTimeout(timer)
  }, [id, lifeMs, version, held])

  const { action } = toast
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 只是用来知道鼠标和焦点在不在上面，能点的是里面的按钮
    <div
      className={toast.tone === 'err' ? 'toast err' : 'toast'}
      data-toast={id}
      role={toast.tone === 'err' ? 'alert' : 'status'}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        dismissToast(id, true)
      }}
    >
      <span className="toast-text ell">{toast.text(t)}</span>
      {action ? (
        <button type="button" className="mini toast-act" onClick={action.run}>
          {action.label(t)}
        </button>
      ) : null}
      <button
        type="button"
        className="ibtn toast-x"
        title={t('toast.close')}
        aria-label={t('toast.close')}
        onClick={() => dismissToast(id, true)}
      >
        <Close />
      </button>
    </div>
  )
}

/** 提示出在哪：放在主区里，浮在内容上面 */
export function Toasts() {
  const shown = useSyncExternalStore(subscribe, () => list)
  if (shown.length === 0) return null
  return (
    <div className="toasts">
      {shown.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
