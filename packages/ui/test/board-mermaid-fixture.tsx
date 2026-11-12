import '../src/styles/index.css'
import { createRoot } from 'react-dom/client'
import { BoardMarkdown } from '../src/manager/BoardMarkdown.tsx'

const source = '```mermaid\nflowchart LR\n A[星云报告] --> B[核对证据]\n B --> C[完成]\n```'
createRoot(document.getElementById('root')!).render(
  <main
    className="mg-board"
    style={{
      padding: 24,
      display: 'grid',
      gridTemplateColumns: 'repeat(2,minmax(0,1fr))',
      gap: 16,
    }}
  >
    {['报告', '决策背景', '讨论与评论', 'issue 正文', '请你做', '建议卡'].map((title) => (
      <section key={title}>
        <h3>{title}</h3>
        <BoardMarkdown text={source} />
      </section>
    ))}
    <section>
      <h3>无效图表回退源码</h3>
      <BoardMarkdown text={'```mermaid\nnot a valid diagram\n```'} />
    </section>
  </main>,
)
