// 网页上的入口：界面预览。地址带 app=1 是一块手机屏（完整的应用，对着模拟核心，按 scene 走到那一屏）；
// 不带就是预览首页（场景列表和手机屏）。预览的代码都在 src/preview/ 和各处的 *.web.ts 里，手机的包里没有
import { useEffect } from 'react'
import App from './App'
import { AntigravityQuotaPreview } from './preview/AntigravityQuota.web.tsx'
import { BoardActionsPreview } from './preview/BoardActions.web.tsx'
import { BoardMermaidPreview } from './preview/BoardMermaid.web.tsx'
import { CjkEmphasisPreview } from './preview/CjkEmphasis.web.tsx'
import { CollapsedTurnPreview } from './preview/CollapsedTurn.web.tsx'
import { ComposeStatePreview } from './preview/ComposeState.web.tsx'
import { applyPrefs, runScene } from './preview/frame.web.ts'
import { PreviewIndex } from './preview/Index.web.tsx'
import { ManagerEventsPreview } from './preview/ManagerEvents.web.tsx'
import { ModelRankingPreview } from './preview/ModelRanking.web.tsx'
import { startScrollNudge } from './preview/nudge.web.ts'
import { sceneById } from './preview/scenes.web.ts'
import { seedOrganizer } from './shell/organizer-file.web.ts'

const params = new URLSearchParams(location.search)
const inFrame = params.has('app')
// 要在 App 读设置、读本机分组之前写好
if (inFrame) {
  applyPrefs(params)
  const groups = sceneById(params.get('scene'))?.localGroups
  if (groups) seedOrganizer('mock', groups)
}

function PreviewApp() {
  useEffect(() => {
    Object.assign(window, {
      __litchLook: {
        set: (patch: Record<string, string>) => {
          const next = new URLSearchParams(location.search)
          for (const [key, value] of Object.entries(patch))
            next.set(key === 'theme' ? 'appearance' : key, value)
          location.search = next.toString()
        },
      },
    })
    void runScene(params.get('scene'))
    return startScrollNudge()
  }, [])
  return <App />
}

export default function Root() {
  if (inFrame && params.get('scene') === 'board-actions') return <BoardActionsPreview />
  if (inFrame && params.get('scene') === 'board-mermaid') return <BoardMermaidPreview />
  if (inFrame && params.get('scene') === 'compose-state') return <ComposeStatePreview />
  if (inFrame && params.get('scene') === 'antigravity-quota')
    return <AntigravityQuotaPreview params={params} />
  if (inFrame && params.get('scene') === 'cjk-emphasis') return <CjkEmphasisPreview />
  if (inFrame && params.get('scene') === 'collapsed-turn')
    return <CollapsedTurnPreview params={params} />
  if (inFrame && params.get('scene') === 'manager-events')
    return <ManagerEventsPreview params={params} />
  if (inFrame && params.get('scene') === 'model-ranking')
    return <ModelRankingPreview params={params} />
  return inFrame ? <PreviewApp /> : <PreviewIndex />
}
