import type { ContextUsage, CoreChannel, SessionSettings } from '@litch/core'
import { useRef, useState } from 'react'
import { needsProviderConfirmation } from './provider-switch.ts'

/** 两端共用确认状态；压缩和切换的顺序交给核心，组件消失也不会提前切换。 */
export function useProviderSwitch(
  channel: CoreChannel,
  deviceId: string,
  sessionId: string,
  harness: string | undefined,
  settings: SessionSettings,
  usage: ContextUsage | null | undefined,
) {
  const key = `${deviceId}:${sessionId}`
  const [selection, setSelection] = useState<{
    key: string
    patch: Partial<SessionSettings>
    busy: boolean
    error?: unknown
  } | null>(null)
  const lock = useRef(false)
  const pending = selection?.key === key ? selection : null
  const close = () => {
    if (!lock.current) setSelection(null)
  }
  const change = (patch: Partial<SessionSettings>) => {
    if (needsProviderConfirmation(harness, settings.model, patch.model ?? null, usage)) {
      setSelection({ key, patch, busy: false })
      return Promise.resolve()
    }
    return channel.command('session.configure', { deviceId, sessionId, settings: patch })
  }
  const confirm = async (compact: boolean) => {
    if (!pending || lock.current) return
    lock.current = true
    setSelection({ ...pending, busy: true })
    try {
      if (compact)
        await channel.command('session.compact', {
          deviceId,
          sessionId,
          thenConfigure: pending.patch,
        })
      else
        await channel.command('session.configure', { deviceId, sessionId, settings: pending.patch })
      setSelection((current) => (current?.key === key ? null : current))
    } catch (error) {
      setSelection((current) =>
        current?.key === key ? { ...pending, busy: false, error } : current,
      )
    } finally {
      lock.current = false
    }
  }
  return { pending, change, confirm, close }
}
