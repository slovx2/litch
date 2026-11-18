// 只连模拟核心，文件数据仅留在内存；无头验收用，不进入正式入口。
import {
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  type FileLinkFailure,
  type HostSink,
  localUserMessage,
  type OutgoingMessage,
  parentPath,
  projectThread,
  serveChannel,
  type UserMessageItem,
} from '@litch/core'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { toInput } from '../../core/src/projection/outgoing.mts'
import type { Thread } from '../../protocol/src/index.mts'
import { ServicesProvider } from '../src/app/services.tsx'
import { Composer } from '../src/composer/Composer.tsx'
import { treeKey, treeUiNow } from '../src/files/state.ts'
import { UserMessage } from '../src/transcript/messages.tsx'
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
const resolves: { deviceId: string; root: string; ref: { path: string } }[] = []
let failure: FileLinkFailure | null = null
let sink: HostSink | null = null
let currentDevice = 'local'
const sessionId = 'attachments-fixture'
const project = (message: OutgoingMessage) =>
  projectThread(
    {
      id: sessionId,
      cwd: '/fixtures',
      turns: [
        {
          id: 't',
          status: 'completed',
          error: null,
          items: [{ id: 'u', type: 'userMessage', content: toInput(message, false) }],
        },
      ],
    } as unknown as Thread,
    { deviceId: currentDevice, harness: 'codex' },
  )
let view = project({ text: '', images: [], extras: [] })
serveChannel(
  server,
  {
    command(name, args, signal) {
      if (name === 'files.attachmentStatus' && cleaned)
        return Promise.resolve({ state: 'cleaned' }) as never
      if (name === 'files.resolve') {
        const request = args as (typeof resolves)[number]
        resolves.push(request)
        if (failure || request.ref.path.startsWith('/fixtures/native/')) {
          return Promise.resolve({
            status: failure ? 'failed' : 'ready',
            href: request.ref.path,
            path: request.ref.path,
            attempted: [request.ref.path],
            candidates: failure
              ? []
              : [{ root: request.root, path: request.ref.path, kind: 'file' }],
            failures: failure ? [{ path: request.ref.path, reason: failure }] : [],
          }) as never
        }
      }
      return mock.command(name, args, signal)
    },
    subscribe(topic, receiver) {
      if (topic.kind === 'session' && topic.sessionId === sessionId) {
        sink = receiver
        receiver.snapshot(view)
        return () => {
          sink = null
        }
      }
      return mock.subscribe(topic, receiver)
    },
  },
  { clock },
)
const channel = connectChannel(client)
const replica = createReplica(channel)
replica.start()
window.__litchLook?.set({ lang: 'zh-CN', skin: 'standard' })
let sent: UserMessageItem | null = null
let show = (_deviceId: string, _message: OutgoingMessage) => {}
let remount = () => {}
Object.assign(window, {
  __attachments: {
    sent: () => sent,
    expire: () => {
      cleaned = true
    },
    resolves: () => resolves.length,
    requests: () => resolves,
    remount: () => remount(),
    fail: (reason: FileLinkFailure | null) => {
      failure = reason
    },
    show: (deviceId: string, message: OutgoingMessage) => show(deviceId, message),
    upload: (deviceId: string) =>
      channel.command('files.uploadAttachment', {
        deviceId,
        name: '11.04 明细 比价(1)(1).xls',
        dataBase64: btoa('isolated fixture'),
      }),
    opened: () => {
      const file = sent?.attachments[0]
      const target = resolves.at(-1)
      return file?.path && target
        ? treeUiNow(treeKey(target.deviceId, parentPath(file.path)!))
        : null
    },
  },
})
function Fixture() {
  const [scene, setScene] = useState({ deviceId: 'local', shown: false, generation: 0 })
  useEffect(() => replica.openSession(scene.deviceId, sessionId), [scene.deviceId])
  show = (deviceId, message) => {
    cleaned = false
    currentDevice = deviceId
    sent = localUserMessage('u', message, false)
    view = project(message)
    if (scene.deviceId === deviceId) sink?.snapshot(view)
    setScene((old) => ({ ...old, deviceId, shown: true, generation: old.generation + 1 }))
  }
  remount = () => setScene((old) => ({ ...old, generation: old.generation + 1 }))
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
        {scene.shown ? (
          <UserMessage
            key={scene.generation}
            deviceId={scene.deviceId}
            sessionId={sessionId}
            itemId="t:u"
          />
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
            show('local', { text, images, extras })
          }}
        />
      </main>
    </ServicesProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
