// 隐藏窗口验收：正式核心、通道和界面，对端与执行器均为内存夹具，不操作真实机器。
import '../src/styles/index.css'
import {
  connectChannel,
  createCore,
  createPortPair,
  createReplica,
  serveChannel,
} from '@litch/core'
import { createRoot } from 'react-dom/client'
import { fakeOpener } from '../../core/test/fake-server.mts'
import { thread, turn } from '../../core/test/fixtures.mts'
import { App } from '../src/app/App.tsx'
import { ServicesProvider } from '../src/app/services.tsx'

const session = thread({
  id: 'm13-session',
  name: 'Review local build output',
  cwd: '/srv/project',
  turns: [turn('t1', [], { status: 'inProgress' })],
})
const peer = fakeOpener({
  'runtime/info': () => ({
    engine: 'pi',
    protocolVersion: '0.163.0',
    cliBuild: '0.99.1',
    capabilities: [],
    releaseReady: true,
    extensions: ['clientTools'],
  }),
  'project/list': () => ({ data: [], nextCursor: null }),
  'thread/list': () => ({
    data: [{ ...session, turns: [] }],
    nextCursor: null,
    backwardsCursor: null,
  }),
  'thread/resume': () => ({
    thread: session,
    model: 'mock',
    reasoningEffort: null,
    sandbox: { type: 'readOnly' },
  }),
  'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
})
let executions = 0
let persisted: unknown = null
let result: unknown = null
let opened = 0
const core = createCore({
  clock: {
    now: () => Date.now(),
    setTimer(callback, ms) {
      const id = setTimeout(callback, ms)
      return () => clearTimeout(id)
    },
  },
  version: '0.26.0',
  store: {
    load: () => ({ localWire: null, remotes: [] }),
    save(value) {
      persisted = value
    },
    snapshot: () => ({ load: () => null, save() {} }),
    forget() {},
  },
  machine: {
    desktop: {
      name: 'Test Mac',
      hostname: 'test-mac',
      system: 'macOS',
      user: 'fixture',
      home: '/fixture',
      shell: '/bin/sh',
    },
    executor: () => ({
      async call(_tool, _args, context) {
        const approval = await context.approve({
          class: 'mutate',
          ask: {
            kind: 'machine',
            action: 'exec',
            command: 'ls -la /fixture/build',
            cwd: '/fixture',
            path: null,
            copy: null,
            flagged: [],
          },
        })
        if (approval.kind === 'allowed') executions++
        return {
          success: approval.kind === 'allowed',
          contentItems: [{ type: 'inputText', text: approval.kind }],
        }
      },
      processes: () => [],
      onProcessesChanged: () => () => {},
      kill: () => false,
      stopAll() {},
      ownerPresence() {},
      dispose() {},
    }),
  },
  devices: [
    {
      id: 'remote',
      name: 'Build server',
      host: 'dev@build.internal',
      kind: 'ssh',
      wire: 'orange',
      target: { kind: 'host', host: 'build.internal', port: null, user: 'dev', keyFile: null },
      open: peer.open,
    },
  ],
})
const [uiPort, hostPort] = createPortPair()
serveChannel(hostPort, core, {
  clock: {
    now: () => Date.now(),
    setTimer(callback, ms) {
      const id = setTimeout(callback, ms)
      return () => clearTimeout(id)
    },
  },
})
const channel = connectChannel(uiPort)
const replica = createReplica(channel)
replica.start()
core.start()
const root = document.getElementById('root')
if (!root) throw new Error('验收页面缺少根元素')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <App />
  </ServicesProvider>,
)
Object.assign(window, {
  m13: {
    call() {
      result = null
      void peer
        .last()
        .ask('item/tool/call', {
          threadId: session.id,
          turnId: 't1',
          callId: `c${++opened}`,
          namespace: 'litch_machine',
          tool: 'exec',
          arguments: { command: 'ls -la /fixture/build' },
        })
        .then((reply) => {
          result = reply
        })
    },
    state: () => ({ executions, persisted, result }),
  },
})
