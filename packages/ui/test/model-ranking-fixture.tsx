// 正式的模型等级排序页与越级提示，对着内存里的预览场景；只回应排序的读写命令，不连设备。
// 地址参数：scene=off|on|unranked|partial|limit，skin、theme、lang 换外观。
import '../src/styles/index.css'
import {
  type CoreChannel,
  createReplica,
  type DeviceView,
  type ModelRankingSnapshot,
} from '@litch/core'
import { createRoot } from 'react-dom/client'
import { setAppearance } from '../src/app/appearance.ts'
import { ServicesProvider } from '../src/app/services.tsx'
import { ModelRanking } from '../src/devices/manage/ModelRanking.tsx'
import { ModelLimitNotice } from '../src/tree/ModelLimitNotice.tsx'
import {
  limitScene,
  type RankingScene,
  rankingScene,
  SCENE_HARNESSES,
} from './fixtures/model-ranking-scenes.ts'

const query = new URLSearchParams(location.search)
const scene = (query.get('scene') ?? 'off') as RankingScene | 'limit'
setAppearance({
  lang: query.get('lang') === 'en' ? 'en' : 'zh-CN',
  skin: (query.get('skin') ?? 'standard') as 'standard',
  theme: (query.get('theme') ?? 'dark') as 'dark',
})
let snapshot: ModelRankingSnapshot = rankingScene(scene === 'limit' ? 'off' : scene)
const channel = {
  async command(name: string, params: Record<string, unknown>) {
    if (name === 'device.modelRanking.read') return snapshot
    if (name === 'device.modelRanking.write')
      snapshot = {
        ...snapshot,
        ...(params as Partial<ModelRankingSnapshot>),
        mode: 'custom',
        revision: snapshot.revision + 1,
      }
    if (name === 'device.modelRanking.reset')
      snapshot = { ...rankingScene('off'), revision: snapshot.revision + 1 }
    return snapshot
  },
} as unknown as CoreChannel
const device = {
  id: 'local',
  name: '本机',
  harnesses: SCENE_HARNESSES.map((entry) => ({ ...entry, reason: null, detail: null })),
  modelRanking: true,
} as unknown as DeviceView
Object.assign(window, { __rankingFixture: { get: () => snapshot } })
const root = document.getElementById('root')
if (!root) throw new Error('排序夹具缺少挂载节点')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica: createReplica(channel), shell: 'browser' }}>
    <main className="mng-wrap" style={{ paddingTop: 12 }}>
      {scene === 'limit' ? (
        <div className="mng" style={{ gap: 24 }}>
          {(['exceeded', 'unranked'] as const).map((kind) => (
            <section key={kind} className="prop-card" style={{ padding: 12 }}>
              <b>整理 CHANGELOG</b>
              <ModelLimitNotice limit={limitScene(kind)} busy={false} onUseModel={() => {}} />
            </section>
          ))}
        </div>
      ) : (
        <div className="mng">
          <ModelRanking device={device} reveal onSettings={() => {}} />
        </div>
      )}
    </main>
  </ServicesProvider>,
)
