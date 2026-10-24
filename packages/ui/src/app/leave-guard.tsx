// 离开一页之前先问：页上有没保存的改动（harness 详情设置的配置、模型清单、指令文件）时，
// 切标签、回上一页、去别的页、开别的设备、关窗口、退出应用之前，弹“保存 / 放弃 / 取消”。
// 有改动的那一块用 useLeaveGuard 登记；要离开的地方用 leaveThen 包一下真正的动作。
// 关窗口、退出由外壳先拦下来（apps/desktop/src/leave-guard.mts），再请界面来问；普通浏览器里（界面预览）用 beforeunload。
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useT } from './appearance.ts'

/** 一块有没保存的改动：保存成了回 true（可以走了），没成回 false（留在原地，原因那一块自己显示） */
type Save = () => Promise<boolean>

const guards = new Set<{ current: Save }>()
/** 正在问：问完了做什么 */
let asking: { go(): void } | null = null
let saving = false
const listeners = new Set<() => void>()
const emit = () => {
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 现在有没有没保存的改动 */
export const hasUnsaved = () => guards.size > 0

/** 告诉外壳现在有没有没保存的改动：有的话它关窗口、退出之前会先请界面问 */
function tellShell() {
  window.litchShell?.setUnsaved?.(hasUnsaved())
}

/** 普通浏览器里（没有外壳）：关标签页、刷新之前让浏览器自己问一声 */
function onBeforeUnload(event: BeforeUnloadEvent) {
  if (!hasUnsaved() || window.litchShell) return
  event.preventDefault()
  event.returnValue = ''
}
if (typeof window !== 'undefined') window.addEventListener('beforeunload', onBeforeUnload)

/**
 * 登记一块的改动。dirty 为真时离开要先问；返回的 ref 里放“保存”（在渲染里随时换成最新的）。
 * 保存要等写成了才回 true
 */
export function useLeaveGuard(dirty: boolean) {
  const save = useRef<Save>(async () => false)
  useEffect(() => {
    if (!dirty) return
    guards.add(save)
    tellShell()
    return () => {
      guards.delete(save)
      tellShell()
    }
  }, [dirty])
  return save
}

/** 要离开：没有没保存的改动就直接走，有就先问 */
export function leaveThen(go: () => void): void {
  if (!hasUnsaved()) {
    go()
    return
  }
  // 已经在问了（又按了一次）：换成这一次要去的地方
  asking = { go }
  emit()
}

function settle(how: 'save' | 'discard' | 'cancel') {
  const pending = asking
  if (!pending || saving) return
  if (how === 'cancel') {
    asking = null
    emit()
    return
  }
  if (how === 'discard') {
    asking = null
    // 放弃：先当作没有改动了，走的路上那一块卸掉时再注销
    guards.clear()
    tellShell()
    emit()
    pending.go()
    return
  }
  saving = true
  emit()
  void Promise.all([...guards].map((guard) => guard.current().catch(() => false))).then((all) => {
    saving = false
    asking = null
    emit()
    if (!all.every(Boolean)) return
    guards.clear()
    tellShell()
    pending.go()
  })
}

// 外壳拦下了关窗口、退出：问完了让它接着做
if (typeof window !== 'undefined')
  window.litchShell?.onLeaveAsk?.(() => leaveThen(() => window.litchShell?.leaveGo?.()))

/** 问的那个对话框：放在应用最外层，问的时候才出来 */
export function LeaveGuardHost() {
  const open = useSyncExternalStore(subscribe, () => asking !== null)
  const busy = useSyncExternalStore(subscribe, () => saving)
  const dialog = useRef<HTMLDialogElement>(null)
  const stay = useRef<HTMLButtonElement>(null)
  const t = useT()
  // 一打开焦点落在不做事的“取消”上：顺手按回车不会把改动丢了
  useEffect(() => {
    const element = dialog.current
    if (!open || !element || element.open) return
    element.showModal()
    stay.current?.focus()
  }, [open])
  if (!open) return null
  return (
    <dialog
      ref={dialog}
      className="modal confirm"
      aria-label={t('leave.title')}
      data-leave-ask
      onCancel={(event) => {
        event.preventDefault()
        settle('cancel')
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) settle('cancel')
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation()
      }}
    >
      <div className="confirm-body">
        <b>{t('leave.title')}</b>
        <span>{t('leave.note')}</span>
        <div className="pick-ask-actions">
          <button
            ref={stay}
            type="button"
            className="btn ghost"
            data-act="leave-cancel"
            disabled={busy}
            onClick={() => settle('cancel')}
          >
            {t('leave.cancel')}
          </button>
          <button
            type="button"
            className="btn danger"
            data-act="leave-discard"
            disabled={busy}
            onClick={() => settle('discard')}
          >
            {t('leave.discard')}
          </button>
          <button
            type="button"
            className="btn primary"
            data-act="leave-save"
            disabled={busy}
            onClick={() => settle('save')}
          >
            {t(busy ? 'manage.saving' : 'leave.save')}
          </button>
        </div>
      </div>
    </dialog>
  )
}
