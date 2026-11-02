// events 流保留所有事件作为断点，不仅监听稀疏的 am_anr。
// 重连读取完整环形缓冲区，确认同一 boot_id 且断点原文仍在；不以“重新连上”代替连续性证明。
import { spawn } from 'node:child_process'

export const eventLogArgs = ['-b', 'events', '-v', 'epoch', '-v', 'usec', '-v', 'printable', '*:V']
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const gap = (message) => Object.assign(new Error(message), { gap: true })

export function eventRecords(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith('---------'))
    .map((line) => {
      const timestamp = line.match(/^\s*(\d+\.\d+)\s+\d+\s+\d+\s+[A-Z]\s+[^:]+:/)?.[1]
      if (!timestamp) throw gap(`无法解析 events 时间戳：${line.slice(0, 200)}`)
      return { timestamp, line }
    })
}

export function replayEvents(text, anchor, onLine) {
  const records = eventRecords(text)
  // 先判 ANR，再判覆盖：即使断点丢失，也不能丢掉已确定的 Litch ANR 归属。
  for (const record of records) onLine(record.line)
  const at = anchor ? records.findIndex((record) => record.line === anchor.line) : -1
  if (anchor && at < 0)
    throw gap(`events 缓冲区已覆盖或清空，找不到断点 ${anchor.timestamp}；不能证明无遗漏`)
  if (!records.length) throw gap('events 缓冲区为空，不能建立连续性断点')
  if (records.slice(at + 1).some((record) => /\bchatty\s*:.*(?:expire|dropped)/i.test(record.line)))
    throw gap('events 存在丢弃记录，不能证明无遗漏')
  return { anchor: records.at(-1), replayed: records.length - at - 1, retained: records.length }
}

/** 所有重连仅重接观察流，不重跑 flow，不执行 adb kill-server/reconnect。 */
export function startEventMonitor({
  adbBin,
  serial,
  run,
  onLine,
  onFailure,
  record,
  startupDeadline = Date.now() + 30000,
}) {
  let stopped = false
  let fatal = false
  let child = null
  let anchor = null
  let bootId = null
  let connected = false
  let recovery = null
  let generation = 0
  let attempts = 0
  const remaining = (deadline) => {
    if (Date.now() >= deadline) throw new Error('events 重连/补读预算耗尽')
    return Math.min(5000, deadline - Date.now())
  }
  const fail = (error) => {
    if (fatal || stopped) return
    fatal = true
    onFailure(error.message)
    child?.kill('SIGTERM')
  }
  const identity = async (deadline) => {
    const id = (
      await run(['shell', 'cat', '/proc/sys/kernel/random/boot_id'], remaining(deadline))
    ).trim()
    if (!id) throw gap('无法读取 boot_id')
    if (bootId && bootId !== id) throw gap('模拟器 boot_id 改变，不能证明 ANR 事件连续')
    bootId = id
  }
  const snapshot = async (deadline) => run(['logcat', '-d', ...eventLogArgs], remaining(deadline))

  function attach(from, deadline) {
    // 不用 -T 过滤掉较早的记录：壁钟回拨/同时间戳的记录也必须能核对。
    // 完整回放至同一条断点，再跟随；这样同时覆盖 dump 与订阅之间的空隙。
    return new Promise((done, reject) => {
      let matched = false
      let pending = ''
      let stderr = ''
      const stream = spawn(adbBin, ['-s', serial, 'logcat', ...eventLogArgs], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child = stream
      generation++
      record('stream-start', { pid: stream.pid, from: from.timestamp, generation })
      const timer = setTimeout(() => {
        reject(gap(`events 实时流未回放到断点 ${from.timestamp}，不能证明连续性`))
        stream.kill('SIGTERM')
      }, remaining(deadline))
      stream.stdout.setEncoding('utf8')
      stream.stderr.setEncoding('utf8')
      stream.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-2048)
      })
      stream.stdout.on('data', (chunk) => {
        if (child !== stream || stopped) return
        pending += chunk
        const end = pending.lastIndexOf('\n')
        if (end < 0) {
          if (pending.length > 65536) {
            fail(gap('events 日志行过长'))
            stream.kill('SIGTERM')
          }
          return
        }
        const text = pending.slice(0, end)
        pending = pending.slice(end + 1)
        try {
          for (const row of eventRecords(text)) {
            onLine(row.line)
            if (!matched && row.line === from.line) {
              matched = true
              clearTimeout(timer)
              connected = true
              done()
            }
            if (matched) {
              if (/\bchatty\s*:.*(?:expire|dropped)/i.test(row.line))
                throw gap('events 实时流报告丢弃记录')
              anchor = row
            }
          }
        } catch (error) {
          clearTimeout(timer)
          reject(error)
          fail(error)
        }
      })
      stream.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      stream.on('close', (code, signal) => {
        clearTimeout(timer)
        if (child !== stream) return
        child = null
        connected = false
        if (!matched) reject(new Error(`events 流连接失败（${code}）：${stderr}`))
        if (stopped || fatal) return
        record('stream-close', {
          code,
          signal,
          stderr,
          from: anchor?.timestamp,
          partialLine: Boolean(pending),
        })
        if (matched) resume()
      })
    })
  }

  function resume(deadline = Date.now() + 30000) {
    if (recovery || stopped || fatal) return recovery
    const from = anchor
    let resumeFrom = anchor
    const started = Date.now()
    recovery = (async () => {
      while (!stopped && !fatal) {
        try {
          attempts++
          remaining(deadline)
          await identity(deadline)
          const result = replayEvents(await snapshot(deadline), resumeFrom, onLine)
          await identity(deadline)
          if (stopped || fatal) return
          record('buffer-verified', {
            bootId,
            from: resumeFrom,
            to: result.anchor,
            retained: result.retained,
            replayed: result.replayed,
          })
          anchor = result.anchor
          resumeFrom = result.anchor
          await attach(result.anchor, deadline)
          record(from ? 'recovered' : 'ready', {
            from: from?.timestamp,
            to: anchor?.timestamp,
            replayed: result.replayed,
            seconds: (Date.now() - started) / 1000,
            attempts,
          })
          return
        } catch (error) {
          if (stopped || fatal) return
          if (error.gap || Date.now() >= deadline) {
            fail(error)
            return
          }
          record('reconnect-wait', { message: error.message, from: from?.timestamp })
          await delay(Math.max(0, Math.min(500, deadline - Date.now())))
        }
      }
    })()
      .catch(fail)
      .finally(() => {
        recovery = null
        if (!connected && !stopped && !fatal) resume(deadline)
      })
    return recovery
  }
  resume(Math.min(startupDeadline, Date.now() + 30000))
  return {
    async checkpoint(timeout = 15000) {
      const deadline = Date.now() + timeout
      while (!stopped && !fatal) {
        try {
          // 等补读完成才能让这条 flow 通过；短暂掉线期间不触碰 Maestro。
          if (recovery) {
            let timer
            try {
              await Promise.race([
                recovery,
                new Promise((_, reject) => {
                  remaining(deadline)
                  timer = setTimeout(
                    () => reject(new Error('events 补读未在检查点预算内完成')),
                    Math.max(1, deadline - Date.now()),
                  )
                }),
              ])
            } finally {
              clearTimeout(timer)
            }
          }
          if (fatal || stopped) return
          if (!connected) {
            resume(deadline)
            continue
          }
          const observedGeneration = generation
          // 流在线时不拿旧断点要求环形缓冲区保留：实时流已经消费了被覆盖的旧事件。
          const records = eventRecords(await snapshot(deadline))
          if (!records.length) throw gap('events 检查点缓冲区为空，不能证明连续性')
          for (const row of records) onLine(row.line)
          if (connected && observedGeneration === generation) return
        } catch (error) {
          if (error.gap || Date.now() >= deadline) {
            fail(error)
            return
          }
          connected = false
          child?.kill('SIGTERM')
          resume(deadline)
          await delay(Math.max(0, Math.min(100, deadline - Date.now())))
        }
      }
    },
    async stop() {
      stopped = true
      child?.kill('SIGTERM')
      await recovery
    },
  }
}
