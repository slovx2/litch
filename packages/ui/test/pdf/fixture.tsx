import '../../src/styles/index.css'
import '../preview/fixture.css'
import { createReplica, type FilePreview } from '@litch/core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ServicesProvider } from '../../src/app/services.tsx'
import { openChannel } from '../../src/boot/channel.ts'
import { FilesTab } from '../../src/files/FilesTab.tsx'
import { LocalPdfData } from '../../src/files/preview/pdf/assets.ts'
import { openFile, treeKey } from '../../src/files/state.ts'

const NativeWorker = window.Worker
const live = new Set<Worker>()
let freezeWorker = false
const violations: string[] = []
document.addEventListener('securitypolicyviolation', (event) =>
  violations.push(event.violatedDirective),
)
window.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options)
    live.add(this)
    if (freezeWorker) this.postMessage = () => {}
  }
  override terminate() {
    live.delete(this)
    super.terminate()
  }
}
const { channel } = await openChannel('zh-CN')
const results = new Map<string, FilePreview>()
const original = channel.command.bind(channel)
channel.command = ((name, params, options) => {
  if (name === 'files.preview') {
    const path = (params as { path: string }).path
    return Promise.resolve(results.get(path) ?? { kind: 'missing', path })
  }
  return original(name, params, options)
}) as typeof channel.command
const replica = createReplica(channel)
replica.start()
const root = '/Users/dev/work/litch',
  deviceId = 'local',
  key = treeKey(deviceId, root)
window.pdfCheck = {
  open(name: string, dataBase64: string, bytes?: number) {
    const path = `${root}/${name}`
    results.set(path, {
      kind: 'ready',
      path,
      dataBase64,
      bytes: bytes ?? atob(dataBase64).length,
      format: 'pdf',
    })
    openFile(key, path)
  },
  leave() {
    openFile(key, `${root}/missing.pdf`)
  },
  workers: () => live.size,
  freeze: (freeze: boolean) => {
    freezeWorker = freeze
  },
  violations: () => violations,
  async asset(kind: string, filename: string) {
    const bytes = await new LocalPdfData().fetch({ kind, filename })
    if (kind === 'wasmUrl') await WebAssembly.compile(new Uint8Array(bytes))
    return bytes.byteLength
  },
}
const mount = document.getElementById('root')
if (!mount) throw new Error('PDF fixture mount missing')
createRoot(mount).render(
  <StrictMode>
    <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
      <div className="preview-check">
        <FilesTab
          place={{ deviceId, workspaceId: 'litch', roots: [root], cwd: root, sessionId: 's3' }}
          shown
        />
      </div>
    </ServicesProvider>
  </StrictMode>,
)
