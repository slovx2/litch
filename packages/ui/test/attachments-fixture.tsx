// 只连模拟核心，文件数据仅留在内存；无头验收用，不进入正式入口。
import {
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  localUserMessage,
  parentPath,
  serveChannel,
  type UserMessageItem,
} from '@litch/core'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ServicesProvider } from '../src/app/services.tsx'
import { Composer } from '../src/composer/Composer.tsx'
import { treeKey, treeUiNow } from '../src/files/state.ts'
import { UserAttachments } from '../src/transcript/messages.tsx'
import '../src/styles/index.css'

const clock = {
  now: Date.now,
  setTimer(fn: () => void, ms: number) {
    const id = setTimeout(fn, ms)
    return () => clearTimeout(id)
  },
}
const mock = createMockCore({ clock })
const [client, server] = createPortPair()
let cleaned = false
let resolves = 0
serveChannel(
  server,
  {
    command(name, args, signal) {
      if (name === 'files.attachmentStatus' && cleaned)
        return Promise.resolve({ state: 'cleaned' }) as never
      if (name === 'files.resolve') resolves++
      return mock.command(name, args, signal)
    },
    subscribe: (topic, sink) => mock.subscribe(topic, sink),
  },
  { clock },
)
const channel = connectChannel(client)
const replica = createReplica(channel)
replica.start()
window.__litchLook?.set({ lang: 'zh-CN', skin: 'standard' })
let sent: UserMessageItem | null = null
Object.assign(window, {
  __attachments: {
    sent: () => sent,
    expire: () => {
      cleaned = true
    },
    resolves: () => resolves,
    opened: () => {
      const file = sent?.attachments[0]
      return file?.path ? treeUiNow(treeKey('local', parentPath(file.path)!)) : null
    },
  },
})
function Fixture() {
  const [message, setMessage] = useState<UserMessageItem | null>(null)
  return (
    <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
      <main
        style={{
          display: 'flex',
          flexDirection: 'column',
          padding: 16,
          width: '100%',
          maxWidth: 800,
          boxSizing: 'border-box',
        }}
      >
        {message ? (
          <div className="umsg">
            <UserAttachments attachments={message.attachments} deviceId="local" />
            <div>{message.text}</div>
          </div>
        ) : null}
        <Composer
          deviceId="local"
          sessionId="s1"
          harness="codex"
          draftKey="attachments"
          cwd="/Users/dev/work/litch"
          placeholder="写消息"
          blocked={null}
          running={false}
          queued={[]}
          settings={{ model: null, effort: null, speed: null, permission: null, mode: null }}
          onSettings={() => {}}
          onSend={async (text, images, extras) => {
            sent = localUserMessage('u', { text, images, extras }, false)
            setMessage(sent)
          }}
        />
      </main>
    </ServicesProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
