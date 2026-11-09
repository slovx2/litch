// 两端 UI 验收共用：正式通道与侧栏投影，只有回报及投递应答由夹具控制。
import type { SidebarOp } from '../src/channel/protocol.mjs'
import type { CoreHost, HostSink } from '../src/channel/server.mjs'
import type { SessionSummary, SidebarView } from '../src/model.mjs'

export function queuedNotesFixture(core: CoreHost) {
  let selected = ''
  let visible = true
  const summaries = new Map<HostSink, SessionSummary>()
  const calls: unknown[] = []
  let resolve: ((result: unknown) => void) | null = null
  let reject: ((reason: Error) => void) | null = null
  const note = {
    threadId: 'fixture-child',
    title: '虚构子线',
    status: 'completed' as const,
    excerpt: '隔离回报正文',
  }
  const decorate = (session: SessionSummary) =>
    session.id === selected ? { ...session, queuedNotes: visible ? [note] : [] } : session
  const refresh = () => {
    for (const [sink, summary] of summaries)
      sink.delta([{ op: 'session.upsert', session: decorate(summary) }])
  }
  const state = {
    calls,
    select(id: string) {
      selected = id
    },
    hideNotes() {
      visible = false
      refresh()
    },
    reset() {
      visible = true
      refresh()
    },
    ack() {
      visible = false
      refresh()
      resolve?.({ delivered: 'woken' })
    },
    none() {
      resolve?.({ delivered: 'none' })
    },
    fail() {
      reject?.(new Error('隔离设备投递失败'))
    },
  }
  const wrapped: CoreHost = {
    subscribe(topic, sink) {
      if (topic.kind !== 'sidebar') return core.subscribe(topic, sink)
      const stop = core.subscribe(topic, {
        ...sink,
        snapshot(value) {
          const sidebar = value as SidebarView
          const summary = sidebar.sessions.find((session) => session.id === selected)
          if (summary) summaries.set(sink, summary)
          sink.snapshot({ ...sidebar, sessions: sidebar.sessions.map(decorate) })
        },
        delta(ops) {
          sink.delta(
            (ops as SidebarOp[]).map((op) => {
              if (op.op !== 'session.upsert') return op
              if (op.session.id === selected) summaries.set(sink, op.session)
              return { ...op, session: decorate(op.session) }
            }),
          )
        },
      })
      return () => {
        summaries.delete(sink)
        stop()
      }
    },
    async command(name, args, signal) {
      if (name === 'session.queuedNotes.deliver') {
        calls.push(args)
        return new Promise((yes, no) => {
          resolve = yes
          reject = no
        })
      }
      return core.command(name, args, signal)
    },
  }
  return { core: wrapped, state }
}
