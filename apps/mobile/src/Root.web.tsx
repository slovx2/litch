// 网页上的入口：界面预览。地址带 app=1 是一块手机屏（完整的应用，对着模拟核心，按 scene 走到那一屏）；
// 不带就是预览首页（场景列表和手机屏）。预览的代码都在 src/preview/ 和各处的 *.web.ts 里，手机的包里没有
import { useEffect } from 'react'
import App from './App'
import { applyPrefs, runScene } from './preview/frame.web.ts'
import { PreviewIndex } from './preview/Index.web.tsx'
import { ManagerEventsPreview } from './preview/ManagerEvents.web.tsx'
import { startScrollNudge } from './preview/nudge.web.ts'

const params = new URLSearchParams(location.search)
const inFrame = params.has('app')
// 要在 App 读设置之前写好
if (inFrame) applyPrefs(params)

function PreviewApp() {
  useEffect(() => {
    void runScene(params.get('scene'))
    return startScrollNudge()
  }, [])
  return <App />
}

export default function Root() {
  if (inFrame && params.get('scene') === 'manager-events')
    return <ManagerEventsPreview params={params} />
  return inFrame ? <PreviewApp /> : <PreviewIndex />
}
