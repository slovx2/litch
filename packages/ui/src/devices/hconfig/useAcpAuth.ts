import type { AcpAuthView, CoreChannel } from '@litch/core'
import { useCallback, useEffect, useRef, useState } from 'react'

/** 两端共用，切设备或离开账号页后不接收旧请求；登录只由点击触发。 */
export function useAcpAuth(channel: CoreChannel, deviceId: string, harness: string) {
  const [data, setData] = useState<AcpAuthView | null>(null)
  const [busy, setBusy] = useState<'read' | 'login' | 'logout' | null>('read')
  const [error, setError] = useState<unknown>(null)
  const generation = useRef(0)
  const lock = useRef(false)
  const run = useCallback(
    async (action: 'read' | 'login' | 'logout', methodId?: string) => {
      if (lock.current) return
      lock.current = true
      const mine = generation.current
      setBusy(action)
      setError(null)
      try {
        const params = { deviceId, harness }
        if (action === 'login' && methodId)
          await channel.command('acp.auth.authenticate', { ...params, methodId })
        if (action === 'logout') await channel.command('acp.auth.logout', params)
        const next = await channel.command('acp.auth.read', params)
        if (mine === generation.current) setData(next)
      } catch (failure) {
        if (mine === generation.current) {
          setData(null)
          setError(failure)
        }
      } finally {
        if (mine === generation.current) {
          lock.current = false
          setBusy(null)
        }
      }
    },
    [channel, deviceId, harness],
  )
  useEffect(() => {
    generation.current++
    lock.current = false
    setData(null)
    void run('read')
    return () => {
      generation.current++
    }
  }, [run])
  // 仅提供订阅方式，API key 仍由已有配置入口处理。
  const methods =
    data?.methods.filter(
      (method) =>
        method.type === 'agent' && ['oauth-personal', 'oauth-business'].includes(method.id),
    ) ?? []
  return { data, busy, error, methods, run }
}
