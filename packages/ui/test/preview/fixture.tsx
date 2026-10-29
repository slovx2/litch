// 只供 headless 验收，走真实文件面板、通道和模拟核心。
import '../../src/styles/index.css'
import './fixture.css'
import { createReplica } from '@litch/core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ServicesProvider } from '../../src/app/services.tsx'
import { openChannel } from '../../src/boot/channel.ts'
import { FilesTab } from '../../src/files/FilesTab.tsx'
import { imageInfo, svgInfo } from '../../src/files/preview/image-info.ts'
import { documentTarget } from '../../src/files/preview/paths.ts'
import { openFile, treeKey } from '../../src/files/state.ts'

const { channel } = await openChannel('zh-CN')
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
  read: (path, format) => channel.command('files.preview', { deviceId, root, path, format }),
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
