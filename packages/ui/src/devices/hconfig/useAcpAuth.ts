import type { AcpAuthLogin, AcpAuthView, CoreChannel } from '@litch/core'
import { useCallback, useEffect, useRef, useState } from 'react'

type Action = 'read' | 'login' | 'continue' | 'cancel' | 'logout'

/** 两端共用；登录结果不改变挂载回调，切设备或离页时撤销未完成的登录。 */
export function useAcpAuth(channel: CoreChannel, deviceId: string, harness: string) {
  const [data, setData] = useState<AcpAuthView | null>(null)
  const [busy, setBusy] = useState<Action | null>('read')
  const [error, setError] = useState<unknown>(null)
  const [login, setLogin] = useState<AcpAuthLogin | null>(null)
  const active = useRef<AcpAuthLogin | null>(null)
  const generation = useRef(0)
  const operation = useRef(0)
  const lock = useRef<Action | null>(null)
  const run = useCallback(
    async (action: Action, value?: string) => {
      if (lock.current && !(action === 'cancel' && lock.current === 'continue')) return
      lock.current = action
      const mine = generation.current
      const op = ++operation.current
      const current = () => mine === generation.current && op === operation.current
      const attempt = active.current
      const clearLogin = () => {
        active.current = null
        setLogin(null)
      }
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
            if (current()) {
              active.current = result.login
              setLogin(result.login)
            } else {
              await channel.command('acp.auth.cancel', {
                ...params,
                attemptId: result.login.attemptId,
              })
            }
            return
          }
        }
        if (action === 'continue' && attempt && value)
          await channel.command('acp.auth.continue', {
            ...params,
            attemptId: attempt.attemptId,
            authorizationCode: value,
          })
        if (action === 'cancel' && attempt)
          await channel.command('acp.auth.cancel', { ...params, attemptId: attempt.attemptId })
        if (action === 'logout') await channel.command('acp.auth.logout', params)
        if (!current()) return
        if (action === 'continue' || action === 'cancel') clearLogin()
        const next = await channel.command('acp.auth.read', params)
        if (current()) setData(next)
      } catch (failure) {
        // 校验失败或连接超时也不能遗留仍在等输入的 CLI。
        if (action === 'continue' && attempt)
          await channel
            .command('acp.auth.cancel', {
              deviceId,
              harness,
              attemptId: attempt.attemptId,
            })
            .catch(() => {})
        if (current()) {
          if (action === 'continue' || action === 'cancel') clearLogin()
          setData(null)
          setError(failure)
        }
      } finally {
        if (current()) {
          lock.current = null
          setBusy(null)
        }
      }
    },
    [channel, deviceId, harness],
  )
  useEffect(() => {
    generation.current++
    lock.current = null
    active.current = null
    setData(null)
    setLogin(null)
    void run('read')
    return () => {
      generation.current++
      const attempt = active.current
      active.current = null
      if (attempt)
        void channel
          .command('acp.auth.cancel', {
            deviceId,
            harness,
            attemptId: attempt.attemptId,
          })
          .catch(() => {})
    }
  }, [run, channel, deviceId, harness])
  // 官方 --login 只提供 Google 账号授权；不把 Enterprise 按个人账号偷偷登录。
  const methods =
    data?.methods.filter((method) => method.type === 'agent' && method.id === 'oauth-personal') ??
    []
  return { data, busy, error, methods, login, run }
}
