// 几何夹具使用正式滚动 hook 和虚拟回合样式，尺寸可控制，不依赖流式输出的墙钟时间。
import { startTransition, useEffect, useLayoutEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { savedTurns, useTranscriptScroll } from '../src/transcript/scroll.ts'
import { FIRST_TURNS, growWindow, restoreWindow } from '../src/transcript/turn-window.ts'
import '../src/styles/transcript.css'

interface Scene {
  key: string
  windowed: boolean
  growth: number
}

let change: (scene: Scene) => void
let grow: () => void
const ids = Array.from({ length: 306 }, (_, n) => String(n))
function App() {
  const [scene, setScene] = useState<Scene>({ key: 'small', windowed: false, growth: 0 })
  change = (next) => flushSync(() => setScene(next))
  grow = () => flushSync(() => setScene((current) => ({ ...current, growth: 34 })))
  return <Fixture key={scene.key} scene={scene} />
}
function Fixture({ scene }: { scene: Scene }) {
  const [count, setCount] = useState(scene.windowed ? FIRST_TURNS : scene.key === 'small' ? 1 : 306)
  useEffect(() => {
    // 首次恢复只补到 12 个，确保断言发生时更早的回合没有蒙混补齐。
    if (!scene.windowed || count >= 12) return
    const timer = setTimeout(() => startTransition(() => setCount((n) => growWindow(n, 12))))
    return () => clearTimeout(timer)
  }, [scene.windowed, count])
  const scroll = useTranscriptScroll(scene.key, ids)
  const [needed] = useState(() => restoreWindow(savedTurns(scene.key)))
  const ready = scene.key === 'small' || count >= needed
  useLayoutEffect(() => {
    if (ready) scroll.restore()
  }, [scroll.restore, ready])
  return (
    <div className="tr-scroll" ref={scroll.scrollerRef} style={{ height: 700 }} aria-busy={!ready}>
      <div
        className="tr"
        ref={scroll.contentRef}
        data-windowed=""
        style={{ boxSizing: 'border-box' }}
      >
        {ids.slice(-count).map((id) => (
          <section className="turn" data-search-turn={id} key={`${scene.key}:${id}`}>
            {/* 固定几何模拟不可压缩的长正文；不让 flex 把内部正文压进 400px 占位框。 */}
            <div
              style={{
                height: Number(id) < 300 ? 3600 : 400 + (id === '300' ? scene.growth : 0),
                flexShrink: 0,
              }}
            >
              <div data-anchor={`a:${id}`}>正文 {id}</div>
            </div>
            <div data-anchor={`t:${id}`} style={{ height: 24, flexShrink: 0 }}>
              回合结尾 {id}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

Object.assign(window, {
  restoreCheck: {
    open: (key: string, windowed = false) => change({ key, windowed, growth: 0 }),
    grow: () => grow(),
  },
})
const root = document.getElementById('root')
if (!root) throw new Error('缺少验收根节点')
createRoot(root).render(<App />)
