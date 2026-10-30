// 验收专用：使用正式 Markdown 组件，不连接设备或个人会话。
import '../../src/styles/index.css'
import { createRoot } from 'react-dom/client'
import { Markdown } from '../../src/transcript/Markdown.tsx'
import { MarkdownPolicyContext } from '../../src/transcript/markdown-policy.ts'
import cases from '../fixtures/cjk-emphasis.json'

const mount = document.getElementById('root')
if (!mount) throw new Error('没有夹具挂载点')
createRoot(mount).render(
  <MarkdownPolicyContext.Provider
    value={{
      link: (href, children) => <a href={href}>{children}</a>,
      image: (_href, alt) => alt,
      code: (_lang, text) => (
        <pre>
          <code>{text}</code>
        </pre>
      ),
    }}
  >
    <main style={{ padding: 24, overflow: 'auto', height: '100vh' }}>
      <h1>桌面 · Markdown 定界符</h1>
      {cases.slice(0, 17).map(({ source }, index) => (
        <section key={source} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <code style={{ whiteSpace: 'pre-wrap' }}>{source}</code>
          <Markdown text={source} streaming={false} anchor={`case:${index}`} />
        </section>
      ))}
    </main>
  </MarkdownPolicyContext.Provider>,
)
