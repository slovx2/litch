// 正式文件树、预览、对话链接与文件卡片；只替换系统文件管理器及保存对话框。
import {
  type Clock,
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  type FileRevealResult,
  type FileSaveProgress,
  type FileSaveRequest,
  type FileSaveSource,
  type SessionSummary,
  serveChannel,
} from '@litch/core'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ServicesProvider } from '../src/app/services.tsx'
import { Toasts } from '../src/app/toasts.tsx'
import type { ShellBridge } from '../src/boot/channel.ts'
import { FilesTab } from '../src/files/FilesTab.tsx'
import { openFile, treeKey } from '../src/files/state.ts'
import { FileCard } from '../src/transcript/FileCard.tsx'
import { FileLinksProvider, Link, useSessionFileLinks } from '../src/transcript/FileLinks.tsx'
import '../src/styles/index.css'

const clock: Clock = {
  now: Date.now,
  setTimer(fn, ms) {
    const timer = window.setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}
const [client, server] = createPortPair()
serveChannel(server, createMockCore({ clock }), { clock })
const channel = connectChannel(client)
const replica = createReplica(channel)
replica.start()
const root = '/Users/dev/work/litch'
const calls: FileSaveSource[] = []
const saves: FileSaveRequest[] = []
const saveListeners = new Set<(value: FileSaveProgress) => void>()
const saveActions: string[] = []
let result: FileRevealResult = 'opened'
window.litchShell = {
  platform: 'darwin',
  revealFile: async (source: FileSaveSource) => {
    calls.push(source)
    return result
  },
  saveFile: async (request: FileSaveRequest) => {
    saves.push(request)
    window.setTimeout(() => {
      for (const listener of saveListeners)
        listener({
          id: request.id,
          state: 'saved',
          bytes: 10,
          total: 10,
          destination: '/client/report',
        })
    }, 20)
  },
  onFileSave: (listener: (value: FileSaveProgress) => void) => {
    saveListeners.add(listener)
    return () => saveListeners.delete(listener)
  },
  fileSaveAction: async (_id: string, action: string) => {
    saveActions.push(action)
  },
} as unknown as ShellBridge

function Fixture() {
  const [deviceId, setDevice] = useState('local')
  const [epoch, setEpoch] = useState(0)
  const links = useSessionFileLinks(deviceId, { cwd: root, workspaceId: null } as SessionSummary)
  Object.assign(window, {
    fileFixture: {
      calls,
      saves,
      saveActions,
      configure(device: string, platform: string) {
        if (window.litchShell) window.litchShell.platform = platform
        setDevice(device)
        setEpoch((value) => value + 1)
        openFile(treeKey(device, root), `${root}/Makefile`)
      },
      open(name: string) {
        openFile(treeKey(deviceId, root), `${root}/${name}`)
      },
      result(value: FileRevealResult) {
        result = value
      },
    },
  })
  return (
    <div
      key={epoch}
      data-fixture-device={deviceId}
      style={{ height: '900px', display: 'flex', flexDirection: 'column' }}
    >
      <div data-card="sent">
        <FileCard
          deviceId={deviceId}
          cwd={root}
          file={{ kind: 'file', label: 'Makefile', path: `${root}/Makefile` }}
        />
      </div>
      <div data-card="client">
        <FileCard
          deviceId={deviceId}
          cwd={root}
          file={{ kind: 'file', label: '本机附件', path: `${root}/Makefile`, client: true }}
        />
      </div>
      <div data-card="windows">
        <FileCard
          deviceId="local"
          file={{ kind: 'file', label: 'Windows 文件', path: 'C:\\Users\\dev\\report.txt' }}
        />
      </div>
      <div data-card="root">
        <FileCard deviceId="local" file={{ kind: 'folder', label: '根目录', path: '/' }} />
      </div>
      <FileLinksProvider value={links}>
        <Link href={`${root}/README.md`}>README.md</Link>
      </FileLinksProvider>
      <FilesTab
        place={{ deviceId, workspaceId: null, roots: [root], cwd: root, sessionId: null }}
        shown
      />
      <Toasts />
    </div>
  )
}
createRoot(document.getElementById('root') as HTMLElement).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <Fixture />
  </ServicesProvider>,
)
