// 正式重置组件与模拟核心；只在边界注入摘要失败、接班失败和迟到预检。
import '../src/styles/index.css'
import {
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  serveChannel,
} from '@litch/core'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Commands } from '../../core/src/channel/protocol.mts'
import { sampleManagers } from '../../core/src/mock/sample-manager.mts'
import type {
  ManagerResetOperation,
  ManagerResetPreview,
  ManagerView,
} from '../../core/src/model-manager.mts'
import { ServicesProvider } from '../src/app/services.tsx'
import { browserClock } from '../src/boot/channel.ts'
import { ResetManager } from '../src/manager/ResetManager.tsx'

type ResetInput = Commands['managers.reset']['params']
type Scenario =
  | 'summaryFailed'
  | 'handoverFailed'
  | 'permissionUnknown'
  | 'blocked'
  | 'delayed'
  | 'sameClaude'
  | 'previewFailure'
  | 'waiting'
  | 'resolvedDispatch'
const base = sampleManagers('local', Date.now(), 'zh-CN').managers.find((one) => one.id === 'm1')
if (!base) throw new Error('缺少示例经理')
const core = createMockCore({ clock: browserClock, lang: 'zh-CN' })
let scenario: Scenario = 'summaryFailed'
let current = structuredClone(base)
let update: (manager: ManagerView) => void = () => {}
let release: (() => void) | undefined
let remount: () => void = () => {}
const requests: ResetInput[] = []
const previews: unknown[] = []
const setManager = (manager: ManagerView) => {
  current = manager
  update(structuredClone(manager))
}
const [uiPort, corePort] = createPortPair()
serveChannel(
  corePort,
  {
    subscribe: core.subscribe.bind(core),
    async command(name, params, signal) {
      if (name === 'managers.reset.preview') {
        previews.push(structuredClone(params))
        const result = (await core.command(name, params, signal)) as ManagerResetPreview
        if (scenario === 'delayed')
          await new Promise<void>((resolve) => {
            release = resolve
          })
        if (scenario === 'previewFailure' && previews.length > 1) throw new Error('预检请求失败')
        if (scenario === 'resolvedDispatch') result.target.dispatch = { ...base.dispatch }
        if (scenario === 'permissionUnknown') result.source.permission = null
        if (scenario === 'blocked') {
          result.canSubmit = false
          result.reasons.push({ code: 'fixture', message: '预检失败：目录不可读' })
        }
        if (scenario === 'sameClaude') {
          result.candidates
            .find((one) => one.harness === 'claude-code')
            ?.models.push({
              id: 'claude-opus-fixture',
              name: 'Claude Opus fixture',
              efforts: ['medium', 'high'],
              defaultEffort: 'high',
            })
        }
        return result
      }
      if (name === 'managers.reset.cancel') {
        setManager(structuredClone(base))
        return { manager: current }
      }
      if (name === 'managers.reset') {
        const input = structuredClone(params) as ResetInput
        if (!input.requestId || !input.target || !input.expectedSettingsHash)
          throw new Error('缺少接班确认计划')
        requests.push(input)
        const preview = (await core.command(
          'managers.reset.preview',
          input,
          signal,
        )) as ManagerResetPreview
        const operation: ManagerResetOperation = {
          requestId: input.requestId,
          source: { ...preview.source, threadId: preview.expectedThreadId },
          target: input.target,
          expectedSettingsHash: input.expectedSettingsHash,
          candidateThreadId: null,
          committed: scenario === 'handoverFailed',
          handover: scenario === 'handoverFailed' ? 'failed' : 'pending',
        }
        setManager({
          ...current,
          reset: {
            current: 'new',
            applied: 'old',
            outdated: true,
            mode: preview.mode,
            phase:
              scenario === 'waiting'
                ? 'waiting'
                : scenario === 'handoverFailed' || input.boardOnly
                  ? 'ready'
                  : 'summaryFailed',
            operation,
          },
        })
        return { manager: current }
      }
      return core.command(name, params, signal)
    },
  },
  { clock: browserClock },
)
const channel = connectChannel(uiPort)
const replica = createReplica(channel)
replica.start()
function Fixture() {
  const [manager, set] = useState(current)
  const [epoch, setEpoch] = useState(0)
  remount = () => setEpoch((value) => value + 1)
  update = set
  useEffect(() => replica.openManagerBoard('local', 'm1'), [])
  return (
    <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
      <div style={{ display: 'flex', justifyContent: 'end', padding: 24 }}>
        <ResetManager key={epoch} manager={manager} disabled={false} />
      </div>
    </ServicesProvider>
  )
}
Object.assign(window, {
  __resetFixture: {
    requests,
    previews,
    scenario(value: Scenario) {
      scenario = value
      setManager(structuredClone(base))
      requests.length = 0
      previews.length = 0
    },
    release() {
      release?.()
      release = undefined
    },
    reload() {
      remount()
    },
    waiting() {
      if (current.reset) setManager({ ...current, reset: { ...current.reset, phase: 'waiting' } })
    },
  },
})
const root = document.getElementById('root')
if (!root) throw new Error('缺少夹具挂载点')
createRoot(root).render(<Fixture />)
