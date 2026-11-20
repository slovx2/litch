// 正式经理建议卡；只有动作回包是替身，模型策略由设备 RPC 定向用例验证。
import '../src/styles/index.css'
import { type CoreChannel, createReplica, keys, type SuggestionView } from '@litch/core'
import { createRoot } from 'react-dom/client'
import { sampleApp } from '../../core/src/mock/sample-data.mts'
import { sampleManagers } from '../../core/src/mock/sample-manager.mts'
import { setAppearance } from '../src/app/appearance.ts'
import { ServicesProvider } from '../src/app/services.tsx'
import { ManagerSuggestions } from '../src/tree/SuggestionsPage.tsx'

const query = new URLSearchParams(location.search)
const lang = query.get('lang') === 'en' ? 'en' : 'zh-CN'
const deviceId = query.get('device') === 'build' ? 'build' : 'local'
setAppearance({ lang, skin: 'standard', theme: 'light' })
const now = Date.now()
const manager = sampleManagers(deviceId, now, lang).managers[0]
const device = sampleApp(lang, now).devices.find((device) => device.id === deviceId)
if (!manager || !device) throw new Error('缺少隔离经理或设备')
const row: SuggestionView = {
  deviceId,
  managerId: manager.id,
  managerReview: { state: 'endorsed', reason: null, at: now },
  source: {
    threadId: 'archived-source',
    title: 'Archived source',
    harness: 'claude-code',
    cwd: '/fixture',
    project: null,
    archived: true,
  },
  proposal: {
    id: 'archived-model',
    title: 'Archived source suggestion',
    prompt: 'Run the task in the card.',
    background: 'Isolated suggestion without an active source session.',
    harness: 'claude-code',
    model: null,
    effort: null,
    cwd: '/fixture',
    kind: 'fresh',
    wakeParent: false,
    offer: false,
    status: 'pending',
    createdAt: now,
    expiresAt: now + 3600_000,
    settledAt: null,
    startedId: null,
    turnId: null,
    callId: null,
    widerSandbox: null,
    worktree: false,
    worktreeDefault: false,
  },
}
const calls: unknown[] = []
const channel = {
  async command(name: string, params: unknown) {
    if (name !== 'session.proposal.accept') throw new Error(`意外命令：${name}`)
    calls.push(params)
    return { sessionId: 'new-workline' }
  },
  subscribe: () => () => {},
  close() {},
} as CoreChannel
const replica = createReplica(channel)
replica.store.set(keys.device(deviceId), { ...device, worktrees: false })
replica.store.set(keys.suggestions, [row])
Object.assign(window, { archivedSuggestionFixture: { calls } })
const root = document.getElementById('root')
if (!root) throw new Error('缺少挂载点')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <main className="mg-board" style={{ width: 600, padding: 20 }}>
      <ManagerSuggestions manager={manager} posts={[]} onOpen={() => {}} />
    </main>
  </ServicesProvider>,
)
