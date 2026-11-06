import type { CoreTrace } from '@litch/core'

const VALUES: Record<string, readonly string[]> = {
  link: ['idle', 'connecting', 'handshaking', 'waiting', 'failed', 'connected'],
  connection: ['offline', 'connecting', 'reconnecting', 'online', 'error'],
  'harness.state': ['ready', 'unavailable', 'disabled'],
  catalog: ['start', 'end'],
}
const HARNESSES = [
  'codex',
  'claude',
  'pi',
  'dsh',
  'opencode',
  'gemini',
  'qwen',
  'acp',
  'antigravity',
]
const REASONS = [
  'connecting',
  'unreachable',
  'handshakeFailed',
  'disconnected',
  'starting',
  'disabled',
  'notInstalled',
  'versionTooLow',
  'startFailed',
  'stopped',
]

/** 沿用核心 trace，只让连接摘要进系统日志；原始标识、RPC 参数和错误原文都不出手机。 */
export function connectionTrace(write: (line: string) => void, now = Date.now): CoreTrace {
  const devices = new Map<string, string>()
  return (event, fields) => {
    const values = VALUES[event]
    const state = fields.phase ?? fields.state
    if (!values || typeof state !== 'string' || !values.includes(state)) return
    if (typeof fields.device !== 'string') return
    let device = devices.get(fields.device)
    if (!device) {
      device = `d${devices.size + 1}`
      devices.set(fields.device, device)
    }
    const record: Record<string, unknown> = { time: now(), device, event, state }
    if (event === 'harness.state' || event === 'catalog') {
      if (typeof fields.harness === 'string')
        record.harness = HARNESSES.includes(fields.harness) ? fields.harness : 'other'
      if (event === 'harness.state')
        record.reason = REASONS.includes(String(fields.reason)) ? fields.reason : null
    }
    if (event === 'catalog' && state === 'end') {
      if (['ok', 'failed', 'superseded'].includes(String(fields.result)))
        record.result = fields.result
      if (typeof fields.elapsedMs === 'number' && Number.isFinite(fields.elapsedMs))
        record.elapsedMs = Math.max(0, Math.round(fields.elapsedMs))
    }
    // 日志写入失败不能中断连接或让状态回调抛错。
    try {
      write(JSON.stringify(record))
    } catch {}
  }
}
