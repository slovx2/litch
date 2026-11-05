import { type TailscaleStatus, tailscale } from './tailscale'

interface LoginOptions {
  signal: AbortSignal
  accept(status: TailscaleStatus): void
  open(url: string): Promise<unknown>
  client?: Pick<typeof tailscale, 'login' | 'status'>
  timeoutMs?: number
  intervalMs?: number
}

// 等待 URL 有独立期限；原生调用迟到后也不能突然弹出浏览器或覆盖新操作。
export async function loginTailscale(server: string, options: LoginOptions): Promise<void> {
  const { signal, accept, open, client = tailscale, timeoutMs = 30_000, intervalMs = 500 } = options
  let ended = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let interval: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const operation = async () => {
    if (signal.aborted) return
    let status = await client.login(server)
    while (!ended && !signal.aborted) {
      accept(status)
      if (status.state === 'connected' || status.state === 'needsApproval') return
      if (status.authURL) {
        await open(status.authURL)
        return
      }
      await new Promise<void>((resolve) => {
        interval = setTimeout(resolve, intervalMs)
      })
      if (ended || signal.aborted) return
      status = await client.status()
    }
  }
  try {
    await Promise.race([
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error('[tailscaleCancelled]'))
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        timer = setTimeout(() => reject(new Error('[tailscaleLoginTimeout]')), timeoutMs)
      }),
      operation(),
    ])
  } finally {
    ended = true
    clearTimeout(timer)
    clearTimeout(interval)
    if (abort) signal.removeEventListener('abort', abort)
  }
}
