import '../src/styles/index.css'
import '../src/app/appearance.ts'
import {
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  serveChannel,
} from '@litch/core'
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ServicesProvider } from '../src/app/services.tsx'
import { browserClock } from '../src/boot/channel.ts'
import { treeKey, treeUiNow } from '../src/files/state.ts'
import { FileLinksProvider } from '../src/transcript/FileLinks.tsx'
import { Markdown } from '../src/transcript/Markdown.tsx'

const core = createMockCore({ clock: browserClock, lang: 'zh-CN', stepMs: 0 })
const [client, server] = createPortPair()
serveChannel(server, core, { clock: browserClock })
const channel = connectChannel(client)
const replica = createReplica(channel)
const calls: unknown[] = []
const original = channel.command.bind(channel)
channel.command = ((name: string, params: unknown, options: unknown) => {
  calls.push({ name, params })
  return original(name as never, params as never, options as never)
}) as typeof channel.command
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
Object.assign(window, {
  mediaFixture: { calls, urls, fileState: () => treeUiNow(treeKey('local', '/work/media-p1')) },
})

function Fixture() {
  const [shown, show] = useState(true)
  return (
    <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
      <button type="button" id="toggle" onClick={() => show((value) => !value)}>
        切换会话
      </button>
      {shown ? (
        <main style={{ padding: 20, width: 900 }}>
          <FileLinksProvider
            value={{
              deviceId: 'local',
              scope: { root: '/work', cwd: '/work' },
              open() {},
            }}
          >
            <h2>本机图片</h2>
            <Markdown
              streaming={false}
              text={
                '![相对图片](./media-p1/photo.png) ![根外图片](/tmp/media-p1/photo.png) ![SVG](/tmp/media-p1/vector.svg)\n\n![坏图](/tmp/media-p1/broken.png) ![超限](/tmp/media-p1/oversize.png) ![逃逸](../media-p1/photo.png)\n\n[普通链接](/tmp/media-p1/no-read.png) `![代码](/tmp/media-p1/code.png)`'
              }
            />
          </FileLinksProvider>
          <FileLinksProvider
            value={{ deviceId: 'build', scope: { root: '/srv/work', cwd: '/srv/work' }, open() {} }}
          >
            <h2>远程设备与外网</h2>
            <Markdown
              streaming={false}
              text={
                '![远程图片](./media-p1/photo.png) ![外网图片](https://media-p1.example.invalid/photo.png)\n\n![失败外网](https://media-p1.example.invalid/failed.png)'
              }
            />
            <div style={{ height: 2000 }} />
            <Markdown
              streaming={false}
              text={'![屏外图片](https://media-p1.example.invalid/lazy.png)'}
            />
          </FileLinksProvider>
        </main>
      ) : null}
    </ServicesProvider>
  )
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
)
