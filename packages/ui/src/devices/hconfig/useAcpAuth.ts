import type { AcpAuthLogin, AcpAuthView, CoreChannel } from '@litch/core'
import { useCallback, useEffect, useRef, useState } from 'react'

/** 两端共用，切设备或离开账号页后不接收旧请求；登录只由点击触发。 */
export function useAcpAuth(channel: CoreChannel, deviceId: string, harness: string) {
  const [data, setData] = useState<AcpAuthView | null>(null)
  const [busy, setBusy] = useState<'read' | 'login' | 'continue' | 'cancel' | 'logout' | null>(
    'read',
  )
  const [error, setError] = useState<unknown>(null)
  const [login, setLogin] = useState<AcpAuthLogin | null>(null)
  const generation = useRef(0)
  const lock = useRef(false)
  const run = useCallback(
    async (action: 'read' | 'login' | 'continue' | 'cancel' | 'logout', value?: string) => {
      if (lock.current) return
      lock.current = true
      const mine = generation.current
      setBusy(action)
      setError(null)
      try {
        const params = { deviceId, harness }
        if (action === 'login' && value) {
          const result = await channel.command('acp.auth.authenticate', {
            ...params,
            methodId: value,
          })
          if (result?.login) {
            setLogin(result.login)
            return
          }
        }
        if (action === 'continue' && login && value)
          await channel.command('acp.auth.continue', {
            ...params,
            attemptId: login.attemptId,
            authorizationCode: value,
          })
        if (action === 'cancel' && login)
          await channel.command('acp.auth.cancel', { ...params, attemptId: login.attemptId })
        if (action === 'logout') await channel.command('acp.auth.logout', params)
        const next = await channel.command('acp.auth.read', params)
        if (mine === generation.current) setData(next)
        if (action === 'continue' || action === 'cancel') setLogin(null)
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
    [channel, deviceId, harness, login],
  )
  useEffect(() => {
    generation.current++
    lock.current = false
    setData(null)
    setLogin(null)
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
  return { data, busy, error, methods, login, run }
}
