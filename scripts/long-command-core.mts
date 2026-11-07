// 隔离工具进程：投影、通道和 Electron MessagePort 都走正式实现。

import { Session } from 'node:inspector'
import {
  type Clock,
  type CoreHost,
  createMockCore,
  type HostSink,
  reduceSession,
  type SessionOp,
  serveChannel,
} from '../packages/core/src/index.mjs'
import { longCommandView } from '../packages/core/test/long-command-fixture.mjs'

const profiler = new Session()
profiler.connect()
profiler.post('Profiler.enable')
profiler.post('Profiler.start')
const clock: Clock = {
  now: Date.now,
  setTimer(fn, ms) {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  },
}
const mock = createMockCore({ clock })
const { view, counts, projectionMs } = longCommandView()
const sinks = new Set<HostSink>()
const timing: object[] = [{ stage: 'projection', ms: projectionMs, counts }]
const replyDelay = Number(process.env.LITCH_LONG_REPLY_MS ?? 500)
let serial = 0
const lastTurn = () => {
  const turn = view.turns.at(-1)
  if (!turn) throw new Error('合成历史没有回合')
  return turn
}
const emit = (ops: SessionOp[]) => {
  const start = performance.now()
  for (const op of ops) reduceSession(view, op)
  timing.push({
    stage: 'core-reduce',
    at: Date.now(),
    ms: performance.now() - start,
    ops: ops.length,
  })
  for (const sink of sinks) sink.delta(ops)
}
const host: CoreHost = {
  async command(name, args, signal) {
    timing.push({ stage: 'command', name, at: Date.now() })
    if (name === 'session.interrupt') {
      await new Promise((r) => setTimeout(r, replyDelay))
      emit([
        {
          op: 'turn.status',
          turnId: lastTurn().id,
          status: 'interrupted',
          durationMs: 1000,
        },
      ])
      return {}
    }
    if (name === 'session.edit') {
      await new Promise((r) => setTimeout(r, replyDelay))
      const at = view.turns.findIndex((t) => t.id === (args as { turnId: string }).turnId)
      emit(view.turns.slice(at).map((t) => ({ op: 'turn.remove', turnId: t.id })))
      return {}
    }
    if (name === 'session.send') {
      const id = `sent${++serial}`
      emit([
        { op: 'turn.add', turn: { ...lastTurn(), id, status: 'running', itemIds: [] } },
        {
          op: 'item.add',
          turnId: id,
          item: {
            id: `${id}:u`,
            kind: 'userMessage',
            text: (args as { text: string }).text,
            attachments: [],
            comments: undefined,
          } as any,
        },
      ])
      return {}
    }
    return mock.command(name, args, signal)
  },
  subscribe(topic, sink) {
    if (topic.kind !== 'session' || topic.sessionId !== view.sessionId)
      return mock.subscribe(topic, sink)
    sinks.add(sink)
    sink.snapshot(view)
    return () => {
      sinks.delete(sink)
    }
  },
}
process.parentPort.on(
  'message',
  ({ ports, data }: { ports: any[]; data?: { profile?: boolean } }) => {
    if (data?.profile) {
      profiler.post('Profiler.stop', (_error, result) =>
        process.parentPort.postMessage({ profile: result?.profile }),
      )
      return
    }
    const port = ports[0]
    serveChannel(
      {
        post(frame) {
          // 大快照的诊断序列化先完成再交付，避免它阻塞已经显示后的首次点击命令。
          const diagnosticStart = performance.now()
          const bytes = Buffer.byteLength(JSON.stringify(frame))
          const diagnosticMs = performance.now() - diagnosticStart
          const at = Date.now(),
            start = performance.now()
          port.postMessage(frame)
          const ms = performance.now() - start
          timing.push({
            stage: 'port-post',
            at,
            ms,
            diagnosticMs,
            type: (frame as any).t,
            bytes,
          })
          process.parentPort.postMessage({ timing: timing.splice(0) })
        },
        listen(fn) {
          port.on('message', (event: any) => fn(event.data))
          port.start()
        },
        close() {
          port.close()
        },
      },
      host,
      { clock },
    )
  },
)
