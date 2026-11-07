import { useCallback, useEffect, useRef, useState } from 'react'

/** 请求应答只是受理；收到回合终态才解除等待。两端共用，迟到应答不污染另一会话。 */
export function useInterrupt(key: string, running: boolean, request: () => Promise<unknown>) {
  const lock = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const [state, setState] = useState<{
    key: string
    busy: boolean
    slow?: boolean
    error?: unknown
  } | null>(null)
  const clear = useCallback(() => {
    if (lock.current) clearTimeout(lock.current.timer)
    lock.current = null
  }, [])
  useEffect(() => {
    if (lock.current?.key !== key) clear()
    setState((current) => (current?.key === key ? current : null))
    return clear
  }, [key, clear])
  useEffect(() => {
    if (!running) {
      clear()
      setState(null)
    }
  }, [running, clear])
  const stop = () => {
    if (!running || lock.current?.key === key) return
    clear()
    const operation = {
      key,
      timer: setTimeout(() => {
        if (lock.current === operation) setState({ key, busy: true, slow: true })
      }, 30_000),
    }
    lock.current = operation
    setState({ key, busy: true })
    // 不等待请求应答才画反馈；成功时继续等待 running=false，Codex 的 ACK 可以先于终态。
    void Promise.resolve()
      .then(request)
      .catch((error: unknown) => {
        if (lock.current !== operation) return
        clear()
        setState({ key, busy: false, error })
      })
  }
  const current = state?.key === key ? state : null
  return { stop, busy: current?.busy ?? false, slow: current?.slow ?? false, error: current?.error }
}
