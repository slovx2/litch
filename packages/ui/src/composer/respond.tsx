// 各种请求卡片（审批、提问、表单）共用的部分：答复、快捷键归谁、卡片底下那一行。
import type { RequestView } from '@litch/core'
import { useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'

export interface CardProps<R extends RequestView = RequestView> {
  deviceId: string
  sessionId: string
  request: R
  /** 这个请求后面还排着几个 */
  waiting: number
}

export interface Choice {
  optionId?: string
  /** 附在决定上的一句说明 */
  note?: string
  answers?: Record<string, string[]>
  values?: Record<string, unknown>
}

/**
 * 卡片的快捷键只在焦点在卡片里、或者哪儿都不在的时候生效。
 * 焦点在别处（侧栏的某一行、别的输入框）时，按键归那边：
 * 不然在侧栏里按回车想打开另一个会话，结果批准了一条命令
 */
export const ownsKey = (event: KeyboardEvent, card: HTMLElement | null): boolean => {
  if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false
  const target = event.target
  return target === document.body || (target instanceof Node && !!card?.contains(target))
}

/** 答复一个请求。答复发出去到卡片消失之间不能再点第二次 */
export function useRespond({ deviceId, sessionId, request }: CardProps) {
  const { channel } = useServices()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 发出去了还没有结果。busy 要等重画才变，这里当场就记下：定时交卷和按键挤在一起也只发一次 */
  const sending = useRef(false)
  const respond = (choice: Choice) => {
    if (sending.current) return
    sending.current = true
    setBusy(true)
    setError(null)
    channel
      .command('session.respond', { deviceId, sessionId, requestId: request.id, ...choice })
      .catch((failure: unknown) => {
        // 成功的话卡片会随着请求一起消失，不用把 busy 放开
        sending.current = false
        setBusy(false)
        setError(t('request.failed', { reason: reasonOf(failure, t) }))
      })
  }
  return { busy, error, respond }
}

export function Foot({ waiting, error }: { waiting: number; error: string | null }) {
  const t = useT()
  if (!error && waiting <= 0) return null
  return (
    <div className="req-foot">
      {error ? <span className="err">{error}</span> : null}
      {waiting > 0 ? <span>{t('request.more', { count: waiting })}</span> : null}
    </div>
  )
}
