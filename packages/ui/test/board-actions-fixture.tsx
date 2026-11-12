import '../src/styles/index.css'
import '../src/styles/manager.css'
import { type CoreChannel, createReplica } from '@litch/core'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { sampleReport } from '../../core/src/mock/manager-posts.mts'
import { sampleManagers } from '../../core/src/mock/sample-manager.mts'
import { ServicesProvider } from '../src/app/services.tsx'
import { CardActionScope, CardActions } from '../src/manager/CardActions.tsx'
import { ManagerFeaturesContext } from '../src/manager/data.ts'
import { Reports } from '../src/manager/Reports.tsx'

const manager = (() => {
  const value = sampleManagers('local', Date.now(), 'zh-CN').managers[0]
  if (!value) throw new Error('缺少隔离经理')
  return value
})()
const report = sampleReport(Date.now(), 'zh-CN')
report.title = '星云项目 · 长报告操作栏'
report.body = `${Array.from(
  { length: 32 },
  (_, i) => `第 ${i + 1} 段：核对星云项目的进度、验收记录和下一步安排。`,
).join('\n\n')}\n\n正文最后一行：全部内容可见。`
const calls: unknown[] = []
const channel = {
  command: async (...args: unknown[]) => {
    calls.push(args)
    return {}
  },
  subscribe: () => () => {},
  close() {},
} as unknown as CoreChannel
Object.assign(window, { __boardActionCalls: calls })
function Fixture() {
  const [count, setCount] = useState(0)
  return (
    <ServicesProvider value={{ channel, replica: createReplica(channel), shell: 'browser' }}>
      <ManagerFeaturesContext.Provider value={{ posts: true, feedback: true, ignore: true }}>
        <main
          className="mg-board"
          style={{
            maxWidth: 820,
            margin: 'auto',
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <header style={{ padding: 16 }}>星云项目 · 经理看板</header>
          <div data-scroll style={{ overflowY: 'auto', flex: 1, minHeight: 0, padding: 16 }}>
            <Reports manager={manager} posts={[report]} disabled={false} />
            {['决策', '建议', '请你做', 'issue'].map((kind) => (
              <CardActionScope key={kind}>
                {(footer) => (
                  <article className="mg-card" data-kind={kind} style={{ marginTop: 16 }}>
                    <h3>{kind} · 星云项目</h3>
                    {Array.from(
                      { length: 24 },
                      (_, i) => `正文第 ${i + 1} 段，核对项目进度与验收。`,
                    ).map((paragraph) => (
                      <p key={paragraph}>
                        {kind} {paragraph}
                      </p>
                    ))}
                    <p data-end>正文最后一行：全部内容可见。</p>
                    <div>
                      <div>
                        <CardActions>
                          <button className="btn" type="button" onClick={() => setCount(count + 1)}>
                            处理 {kind} · {count}
                          </button>
                        </CardActions>
                      </div>
                    </div>
                    {/* 内嵌帖子继承外层作用域，不生成第二条操作栏。 */}
                    <CardActionScope>
                      {(nested) => (
                        <>
                          {nested}
                          <CardActions>
                            <button className="btn" type="button">
                              回复
                            </button>
                          </CardActions>
                        </>
                      )}
                    </CardActionScope>
                    {footer}
                  </article>
                )}
              </CardActionScope>
            ))}
          </div>
        </main>
      </ManagerFeaturesContext.Provider>
    </ServicesProvider>
  )
}
const root = document.getElementById('root')
if (!root) throw new Error('缺少隔离挂载点')
createRoot(root).render(<Fixture />)
