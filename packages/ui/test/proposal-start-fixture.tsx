// 正式卡片和编辑弹窗，经消息端口到可延迟/拒绝的模拟核心。
import {
  type Clock,
  type CoreHost,
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  keys,
  type SessionProposalView,
  serveChannel,
} from '@litch/core'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { setAppearance } from '../src/app/appearance.ts'
import { ServicesProvider, useKey } from '../src/app/services.tsx'
import { ProposalActs, StartedChild } from '../src/tree/ProposalCard.tsx'
import '../src/styles/index.css'

setAppearance({ lang: 'zh-CN' })
const clock: Clock = {
  now: Date.now,
  setTimer(fn, ms) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}
const mock = createMockCore({ clock })
let release: (() => void) | null = null
let fail: ((reason: Error) => void) | null = null
const calls: unknown[] = []
const host: CoreHost = {
  subscribe: (topic, sink) => mock.subscribe(topic, sink),
  async command(name, args, signal) {
    if (name === 'session.proposal.accept') {
      calls.push(args)
      await new Promise<void>((resolve, reject) => {
        release = resolve
        fail = reject
      })
    }
    return mock.command(name, args, signal)
  },
}
const [client, server] = createPortPair()
serveChannel(server, host, { clock })
const channel = connectChannel(client)
const replica = createReplica(channel)
replica.start()
const { sessionId } = await channel.command('session.create', {
  deviceId: 'local',
  cwd: '/',
  text: '提个子会话',
})
replica.openSession('local', sessionId)
Object.assign(window, {
  proposalFixture: {
    calls,
    ack: () => release?.(),
    fail: () => fail?.(new Error('隔离设备启动失败')),
  },
})
function Fixture() {
  const proposals = useKey<SessionProposalView[]>(keys.proposals('local', sessionId))
  const proposal = proposals?.[0]
  const [visible, setVisible] = useState(true)
  const [count, setCount] = useState(0)
  return (
    <main style={{ width: 540, padding: 20 }}>
      <button id="other-action" type="button" onClick={() => setCount(count + 1)}>
        其他操作 {count}
      </button>
      <button id="toggle-card" type="button" onClick={() => setVisible(!visible)}>
        切页
      </button>
      {visible && proposal ? (
        <section data-proposal={proposal.id} data-status={proposal.status}>
          <p>{proposal.prompt}</p>
          {proposal.status === 'pending' ? (
            <ProposalActs deviceId="local" sessionId={sessionId} proposal={proposal} />
          ) : null}
          {proposal.startedId ? (
            <StartedChild deviceId="local" childId={proposal.startedId} title={proposal.title} />
          ) : null}
        </section>
      ) : null}
    </main>
  )
}
const root = document.getElementById('root')
if (!root) throw new Error('缺少夹具根节点')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <Fixture />
  </ServicesProvider>,
)
