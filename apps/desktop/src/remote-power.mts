// 桌面只报远程工作证据；租约仍由本机 Go 服务统一申请与释放。
import { createConnection, type Socket } from 'node:net'
import type { CoreHost } from '@litch/core'
import { RemotePowerActivity, watchRemotePower } from './remote-power-activity.mjs'

export function reportRemotePower(
  core: CoreHost,
  path: string,
  log: (line: string) => void,
): () => void {
  const activity = new RemotePowerActivity()
  let socket: Socket | null = null
  let ready = false
  let stopped = false
  let pending: number | null = null
  let deadline: NodeJS.Timeout | null = null
  let buffer = ''
  let warned = false
  let dirty = true

  const failed = (reason: string) => {
    if (!warned) log(`远程任务防休眠摘要未送达本机服务：${reason}`)
    warned = true
  }
  const send = () => {
    if (!socket || !ready || pending !== null) return
    dirty = false
    const report = activity.snapshot()
    pending = report.sequence
    socket.write(
      `${JSON.stringify({ id: report.sequence, method: 'power.remoteActivity', params: report })}\n`,
    )
    deadline = setTimeout(() => {
      failed('控制通道应答超时')
      socket?.destroy()
    }, 5000)
    deadline.unref()
  }
  const connect = () => {
    if (socket || stopped) return
    buffer = ''
    const connection = createConnection(path)
    socket = connection
    connection.setEncoding('utf8')
    connection.unref()
    connection.on('connect', () => {
      ready = true
      send()
    })
    connection.on('data', (data: string) => {
      buffer += data
      if (buffer.length > 16 * 1024 * 1024) {
        connection.destroy(new Error('控制通道应答过大'))
        return
      }
      for (;;) {
        const end = buffer.indexOf('\n')
        if (end < 0) break
        const raw = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let frame: { id?: number; ask?: number; error?: { text?: { 'zh-CN'?: string } } }
        try {
          frame = JSON.parse(raw)
        } catch {
          connection.destroy(new Error('控制通道应答无效'))
          return
        }
        // 控制通道广播的设置不参与判断，也不记录（其中可能有密钥）。
        if (typeof frame.ask === 'number') {
          connection.write(
            `${JSON.stringify({ reply: frame.ask, error: 'not the device process' })}\n`,
          )
        }
        if (frame.id !== pending) continue
        pending = null
        if (deadline) clearTimeout(deadline)
        deadline = null
        if (frame.error) failed(frame.error.text?.['zh-CN'] ?? '控制通道拒绝请求')
        else warned = false
        if (dirty && !stopped) send()
      }
    })
    connection.on('error', (error: Error) => failed(error.message))
    connection.on('close', () => {
      if (deadline) clearTimeout(deadline)
      deadline = null
      socket = null
      ready = false
      pending = null
    })
  }
  const changed = () => {
    dirty = true
    connect()
    send()
  }
  const unwatch = watchRemotePower(core, activity, changed)
  // 这是向本机服务续租，不请求远程设备；断线/未知条目仍带最初 observedAgoMs。
  const heartbeat = setInterval(changed, 15_000)
  heartbeat.unref()
  return () => {
    if (stopped) return
    stopped = true
    unwatch()
    clearInterval(heartbeat)
    if (deadline) clearTimeout(deadline)
    // 正常关闭立即报空；异常退出由本机服务的 90 秒证据期限兜住。
    if (ready && socket) {
      const report = activity.snapshot()
      socket.end(
        `${JSON.stringify({ id: report.sequence, method: 'power.remoteActivity', params: { ...report, sources: [] } })}\n`,
      )
    } else socket?.destroy()
  }
}
