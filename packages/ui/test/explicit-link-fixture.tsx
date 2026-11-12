import '../src/styles/index.css'
import { type FileLinkResolution, type FileRef, parentPath } from '@litch/core'
import { createRoot } from 'react-dom/client'
import type { ShellBridge } from '../src/boot/channel.ts'
import { FileLinksProvider } from '../src/transcript/FileLinks.tsx'
import { Markdown } from '../src/transcript/Markdown.tsx'

const cases = [
  '[nebula-link-test/](/tmp/nebula-link-test/)',
  '[docs/report.md](/tmp/nebula-link-test/report.md)',
  '[`nebula-link-test/`](/tmp/nebula-link-test/)',
  '[**docs/** *report.md*](/tmp/nebula-link-test/report.md)',
  '[https://nebula.example.invalid/docs/report.md](/tmp/nebula-link-test/report.md)',
  '[docs/report.md](https://nebula.example.invalid/docs/report.md)',
]
const calls: { href: string; ref: FileRef }[] = [],
  opened: string[] = [],
  system: string[] = [],
  copied: string[] = []
let fail = false
window.litchShell = { openExternal: (url: string) => system.push(url) } as unknown as ShellBridge
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      copied.push(text)
    },
  },
})
Object.assign(window, {
  __explicitLinks: {
    cases,
    calls,
    opened,
    system,
    copied,
    fail: () => {
      fail = true
    },
  },
})
const root = document.getElementById('root')
if (!root) throw Error('缺少测试根节点')
createRoot(root).render(
  <main style={{ padding: 24, maxWidth: 760, margin: '0 auto' }}>
    <h2>星云 · Markdown 显式链接</h2>
    <FileLinksProvider
      value={{
        scope: { root: '/srv/nebula', cwd: '/srv/nebula' },
        async resolve(ref, href): Promise<FileLinkResolution> {
          calls.push({ ref, href })
          const path = ref.path
          return {
            status: fail ? 'failed' : 'ready',
            href,
            path,
            attempted: [path, '/srv/nebula/other/report.md'],
            candidates: fail
              ? []
              : [
                  {
                    root: parentPath(path) ?? '/',
                    path,
                    kind: href.endsWith('/') ? 'directory' : 'file',
                  },
                ],
            failures: fail
              ? [
                  { path, reason: 'missing' },
                  { path: '/srv/nebula/other/report.md', reason: 'missing' },
                ]
              : [],
          }
        },
        open(ref) {
          opened.push(ref.path)
        },
      }}
    >
      {cases.map((text, index) => (
        <section key={text} data-case={index}>
          <Markdown text={text} streaming={false} />
        </section>
      ))}
    </FileLinksProvider>
  </main>,
)
