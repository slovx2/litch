import '../src/styles/index.css'
import '../src/app/appearance.ts'
import {
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  type FileSaveProgress,
  serveChannel,
} from '@litch/core'
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SAMPLE_TOOL_IMAGES } from '../../core/src/mock/sample-tool-images.mts'
import { ServicesProvider } from '../src/app/services.tsx'
import { Toasts } from '../src/app/toasts.tsx'
import type { ShellBridge } from '../src/boot/channel.ts'
import { browserClock } from '../src/boot/channel.ts'
import { treeKey, treeUiNow } from '../src/files/state.ts'
import type { BrowserBridge } from '../src/side/browser/bridge.ts'
import { setLinksInBrowser } from '../src/side/browser/links.ts'
import { setViewing } from '../src/side/browser/store.ts'
import { FileLinksProvider } from '../src/transcript/FileLinks.tsx'
import { Markdown } from '../src/transcript/Markdown.tsx'
import { ToolImageStrip } from '../src/transcript/media/ToolImages.tsx'

const core = createMockCore({ clock: browserClock, lang: 'zh-CN', stepMs: 0 })
const [client, server] = createPortPair()
serveChannel(server, core, { clock: browserClock })
const channel = connectChannel(client)
const replica = createReplica(channel)
replica.start()
const calls: unknown[] = []
const original = channel.command.bind(channel)
channel.command = ((name: string, params: unknown, options: unknown) => {
  calls.push({ name, params })
  return original(name as never, params as never, options as never)
}) as typeof channel.command
const urls = new Set<string>()
const menuMode = new URLSearchParams(location.search).has('menu')
const effects = {
  paths: [] as string[],
  png: [] as number[],
  reveal: [] as unknown[],
  save: [] as unknown[],
  browser: [] as unknown[],
  system: [] as string[],
  failCopy: false,
  failReveal: false,
}
if (menuMode) {
  const listeners = new Set<(progress: FileSaveProgress) => void>()
  window.litchShell = {
    setLanguage() {},
    setLook() {},
    platform: 'darwin',
    openExternal: (href) => effects.system.push(href),
    revealFile: async (source) => {
      effects.reveal.push(source)
      return effects.failReveal ? 'missing' : 'opened'
    },
    saveFile: async (source) => {
      effects.save.push(source)
      for (const listener of listeners) listener({ id: source.id, state: 'cancelled' })
    },
    onFileSave: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    fileSaveAction: async () => {},
  } as ShellBridge
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (path: string) => {
        if (effects.failCopy) throw new Error('虚构剪贴板不可用')
        effects.paths.push(path)
      },
      write: async (items: ClipboardItem[]) => {
        if (effects.failCopy) throw new Error('虚构剪贴板不可用')
        for (const item of items) effects.png.push((await item.getType('image/png')).size)
      },
    },
  })
  window.litchBrowser = {
    tabs: async () => [],
    open: async (owner: unknown, url: string) => {
      effects.browser.push({ owner, url })
      return { id: 'atlas-user-tab' }
    },
  } as unknown as BrowserBridge
  setViewing({ deviceId: 'build', threadId: 'atlas-session' })
  setLinksInBrowser(true)
}
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
  mediaFixture: {
    calls,
    urls,
    effects,
    setLinksInBrowser,
    fileState: (device = 'local', root = '/work/media-p1') => treeUiNow(treeKey(device, root)),
  },
})

function Fixture() {
  const [shown, show] = useState(true)
  return (
    <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
      <Toasts />
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
            {menuMode ? (
              <section id="tool-fixture">
                <h2>工具结果图片</h2>
                <ToolImageStrip deviceId="build" images={SAMPLE_TOOL_IMAGES} />
              </section>
            ) : null}
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
