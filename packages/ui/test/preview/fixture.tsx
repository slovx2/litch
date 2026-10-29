// 只供 headless 验收，走真实文件面板、通道和模拟核心。
import '../../src/styles/index.css'
import './fixture.css'
import { createReplica, type FilePreview, type PreviewKind } from '@litch/core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ServicesProvider } from '../../src/app/services.tsx'
import { openChannel } from '../../src/boot/channel.ts'
import { FilesTab } from '../../src/files/FilesTab.tsx'
import { imageInfo, svgInfo } from '../../src/files/preview/image-info.ts'
import { documentTarget } from '../../src/files/preview/paths.ts'
import { clearReveal, openFile, revealPath, selectPath, treeKey } from '../../src/files/state.ts'

const { channel } = await openChannel('zh-CN')
const reads = new Map<string, number>()
const results = new Map<string, FilePreview>()
const originalCommand = channel.command.bind(channel)
channel.command = ((name, params, options) => {
  if (name === 'files.preview') {
    const path = (params as { path: string }).path
    reads.set(path, (reads.get(path) ?? 0) + 1)
    const result = results.get(path)
    if (result) return Promise.resolve(result)
  }
  return originalCommand(name, params, options)
}) as typeof channel.command
const replica = createReplica(channel)
replica.start()
const root = '/Users/dev/work/litch',
  deviceId = 'local'
const uiKey = treeKey(deviceId, root)
const urls = new Set<string>()
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
window.previewCheck = {
  open: (path, line) => openFile(uiKey, `${root}/${path}`, { line: line ?? null }),
  svgInfo,
  imageInfo,
  documentTarget,
  liveUrls: () => urls.size,
  readCount: (path: string) => reads.get(`${root}/${path}`) ?? 0,
  rerenderParent: () => {
    selectPath(uiKey, `${root}/Makefile`)
    revealPath(uiKey, `${root}/docs`)
    clearReveal(uiKey, `${root}/docs`)
  },
  result: (path: string, result: Omit<FilePreview, 'path'>) =>
    results.set(`${root}/${path}`, { ...result, path: `${root}/${path}` } as FilePreview),
  markdown: (path: string, text: string) => {
    const bytes = new TextEncoder().encode(text)
    results.set(`${root}/${path}`, {
      kind: 'ready',
      path: `${root}/${path}`,
      format: 'markdown',
      bytes: bytes.length,
      dataBase64: btoa(String.fromCharCode(...bytes)),
    })
    openFile(uiKey, `${root}/${path}`)
  },
  read: (path: string, format: PreviewKind) =>
    channel.command('files.preview', { deviceId, root, path, format }),
}
const mount = document.getElementById('root')
if (!mount) throw new Error('没有夹具挂载点')
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
window.previewCheck.open('docs/images/preview.md')
