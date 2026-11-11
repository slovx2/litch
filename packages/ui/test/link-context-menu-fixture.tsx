// 正式网页链接和 Markdown；浏览器外壳与剪贴板使用隔离替身，不改个人剪贴板也不访问公网。
import { createRoot } from 'react-dom/client'
import type { ShellBridge } from '../src/boot/channel.ts'
import { DocsLink } from '../src/install/InstallRow.tsx'
import { BoardMarkdown } from '../src/manager/BoardMarkdown.tsx'
import type { BrowserBridge } from '../src/side/browser/bridge.ts'
import { setLinksInBrowser } from '../src/side/browser/links.ts'
import { setViewing } from '../src/side/browser/store.ts'
import { ExternalLink } from '../src/transcript/ExternalLink.tsx'
import { Markdown } from '../src/transcript/Markdown.tsx'
import '../src/styles/index.css'

const copied: string[] = [],
  system: string[] = [],
  opened: { owner: unknown; url: string }[] = []
const url = 'https://atlas.example.invalid/a?q=hello%20world#part'
const owner = { deviceId: 'fictional-device', threadId: 'fictional-session' }
const bridge = {
  tabs: async () => [],
  open: async (who: unknown, href: string) => {
    opened.push({ owner: who, url: href })
    return { id: 'fictional-user-tab' }
  },
} as unknown as BrowserBridge
window.litchBrowser = bridge
window.litchShell = {
  platform: 'darwin',
  openExternal: (href: string) => system.push(href),
} as unknown as ShellBridge
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (href: string) => {
      copied.push(href)
    },
  },
})
setViewing(owner)
setLinksInBrowser(true)
Object.assign(window, {
  linkFixture: {
    copied,
    system,
    opened,
    url,
    owner,
    enabled: setLinksInBrowser,
    browser(on: boolean) {
      if (on) window.litchBrowser = bridge
      else delete window.litchBrowser
    },
    session(on: boolean) {
      setViewing(on ? owner : null)
    },
  },
})
const root = document.getElementById('root')
if (!root) throw Error('缺少测试根节点')
createRoot(root).render(
  <main style={{ padding: 24 }}>
    <div id="direct">
      <ExternalLink href={url}>网页链接</ExternalLink>
    </div>
    <div id="prose">
      <Markdown
        text={`[正文链接](${url}) 自动网址 https://atlas.example.invalid/auto`}
        streaming={false}
      />
    </div>
    <div id="board">
      <BoardMarkdown text={`[看板正文](${url})`} />
    </div>
    <div id="docs">
      <DocsLink href={url}>说明文档</DocsLink>
    </div>
    {/* biome-ignore lint/security/noScriptUrl: 负测非法协议，确认不会生成可点击链接。 */}
    <ExternalLink href="javascript:alert(1)">不可点击协议</ExternalLink>
    <dialog id="link-dialog">
      <ExternalLink href={url}>模态卡片链接</ExternalLink>
    </dialog>
  </main>,
)
