// 只供无窗口验收：正式文件面板、共享通道和受控字节夹具。
import '../../src/styles/index.css'
import '../preview/fixture.css'
import { createReplica, type FilePreview, type PreviewKind } from '@litch/core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ServicesProvider } from '../../src/app/services.tsx'
import { openChannel } from '../../src/boot/channel.ts'
import { FilesTab } from '../../src/files/FilesTab.tsx'
import { htmlDocument, sanitizeHtml } from '../../src/files/preview/web/html.ts'
import { closeFile, openFile, treeKey } from '../../src/files/state.ts'

const { channel } = await openChannel('zh-CN')
const root = '/Users/dev/work/litch',
  deviceId = 'local',
  uiKey = treeKey(deviceId, root)
const results = new Map<string, FilePreview>()
const reads: string[] = []
const original = channel.command.bind(channel)
channel.command = ((name, params, options) => {
  if (name === 'files.preview') {
    const path = (params as { path: string }).path
    reads.push(path)
    return Promise.resolve(results.get(path) ?? { kind: 'missing', path })
  }
  return original(name, params, options)
}) as typeof channel.command
const replica = createReplica(channel)
replica.start()
const urls = new Set<string>(),
  workers = new Set<Worker>()
const create = URL.createObjectURL.bind(URL),
  revoke = URL.revokeObjectURL.bind(URL)
URL.createObjectURL = (blob) => {
  const url = create(blob)
  urls.add(url)
  return url
}
URL.revokeObjectURL = (url) => {
  urls.delete(url)
  revoke(url)
}
const NativeWorker = window.Worker
window.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options)
    workers.add(this)
  }
  override terminate() {
    workers.delete(this)
    super.terminate()
  }
}
let opened = ''
Object.assign(window, {
  previewWeb: {
    seed(path: string, format: PreviewKind, dataBase64: string) {
      results.set(`${root}/${path}`, {
        kind: 'ready',
        path: `${root}/${path}`,
        format,
        dataBase64,
        bytes: atob(dataBase64).length,
      })
    },
    failure(path: string, kind: 'tooLarge' | 'missing' | 'unsupported') {
      results.set(`${root}/${path}`, {
        kind,
        path: `${root}/${path}`,
        bytes: 100_000_000,
        limit: 1024,
      } as FilePreview)
    },
    open(path: string) {
      opened = `${root}/${path}`
      openFile(uiKey, opened)
    },
    close() {
      closeFile(uiKey, opened)
    },
    reads: () => reads,
    live: () => ({ urls: urls.size, workers: workers.size }),
    html(source: string) {
      return htmlDocument(sanitizeHtml(source).fragment)
    },
  },
})
const mount = document.getElementById('root')
if (!mount) throw new Error('无挂载点')
createRoot(mount).render(
  <StrictMode>
    <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
      <div className="preview-check">
        <header>文件预览</header>
        <FilesTab
          place={{ deviceId, workspaceId: 'litch', roots: [root], cwd: root, sessionId: 's3' }}
          shown
        />
      </div>
    </ServicesProvider>
  </StrictMode>,
)
