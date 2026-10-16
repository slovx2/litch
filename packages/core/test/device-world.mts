// 完整模式的测试共用的搭建：一个真的核心，对面是假的聚合面（fake-device.mts）。
// 侧栏、设备的显示数据都像界面那样把快照和增量落下来；会话经真的通道订阅（wire.mts 的 watchSession）。
import type { HarnessFeatures, PermissionPreset } from '../../protocol/src/index.mjs'
import {
  type AppOp,
  type AppView,
  createCore,
  type DeviceView,
  type SessionSummary,
  type SidebarOp,
  type SidebarView,
} from '../src/index.mjs'
import { type FakeDevice, type FakeHarness, fakeDevice, infoOf } from './fake-device.mjs'
import { fakeOpener, type Handler } from './fake-server.mjs'
import { fakeClock } from './helpers.mjs'

const never = { aborted: false, addEventListener() {} }

/** 一份什么都会的能力声明。overrides 改其中几位 */
export const features = (overrides: Partial<HarnessFeatures> = {}): HarnessFeatures => ({
  steer: true,
  interrupt: true,
  compact: true,
  fork: true,
  revert: { byTurnId: true, byCount: true, restoresFiles: false },
  queue: false,
  turnDiff: false,
  commandOutputDelta: false,
  approvals: { kinds: ['command', 'fileChange'], uncovered: [] },
  userInput: true,
  mcpElicitation: false,
  planUpdates: true,
  inputTypes: ['text', 'image'],
  steerInputTypes: ['text', 'image'],
  archive: true,
  delete: true,
  rename: true,
  agentMessagePhase: 'onCompleted',
  ...overrides,
})

/** 声明里的一档权限预设 */
export const declaredPreset = (
  id: string,
  fields: Partial<PermissionPreset> = {},
): PermissionPreset => ({
  id,
  title: { 'zh-CN': `${id} 的标题`, en: `${id} title` },
  description: { 'zh-CN': `${id} 的说明`, en: `${id} note` },
  risk: 'medium',
  requiresConfirmation: false,
  switchInSession: true,
  switchDuringTurn: false,
  ...fields,
})

export function deviceWorld(
  harnesses: FakeHarness[],
  options: {
    /** 连上之前先改一改假设备（声明的扩展、预先放好的工作区之类） */
    prepare?(device: FakeDevice): void
    /** 另外的、或者要盖掉的方法 */
    extra?: Record<string, Handler>
  } = {},
) {
  const fake = fakeDevice(harnesses)
  options.prepare?.(fake.device)
  const time = fakeClock()
  const peer = fakeOpener({ ...fake.handlers, ...options.extra })
  const logs: string[] = []
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    log: (line) => logs.push(line),
    devices: [
      {
        id: 'local',
        name: '本机',
        host: 'dev@mac',
        kind: 'local',
        target: null,
        wire: 'green',
        open: peer.open,
      },
    ],
  })
  const app = { first: null as AppView | null, ops: [] as AppOp[] }
  core.subscribe(
    { kind: 'app' },
    {
      snapshot: (data) => {
        app.first = data as AppView
      },
      delta: (ops) => app.ops.push(...(ops as AppOp[])),
      error() {},
    },
  )
  const side = {
    sessions: new Map<string, SessionSummary>(),
    workspaces: [] as SidebarView['workspaces'],
    /** 侧栏整份换过几次 */
    snapshots: 0,
  }
  core.subscribe(
    { kind: 'sidebar', deviceId: 'local' },
    {
      snapshot(data) {
        const view = data as SidebarView
        side.sessions = new Map(view.sessions.map((entry) => [entry.id, entry]))
        side.workspaces = view.workspaces
        side.snapshots++
      },
      delta(ops) {
        for (const op of ops as SidebarOp[]) {
          if (op.op === 'session.upsert') side.sessions.set(op.session.id, op.session)
          else if (op.op === 'session.remove') side.sessions.delete(op.sessionId)
        }
      },
      error() {},
    },
  )
  const device = (): DeviceView | undefined => {
    const last = app.ops.findLast((op) => op.op === 'device.upsert')
    return last?.op === 'device.upsert' ? last.device : app.first?.devices[0]
  }
  const command = (name: string, params: object) =>
    core.command(name, { deviceId: 'local', ...params }, never)
  /** 对面收到过的某个方法的参数，按到达顺序 */
  const sent = (method: string) =>
    peer
      .last()
      .seen.filter((entry) => entry.method === method)
      .map((entry) => entry.params as Record<string, unknown>)
  const find = (id: string): FakeHarness => {
    const entry = fake.device.harnesses.find((item) => item.id === id)
    if (!entry) throw new Error(`没有这个假 harness：${id}`)
    return entry
  }
  /** 改一个 harness 的可用状态，并像设备服务那样发通知 */
  const set = (id: string, down: FakeHarness['down']) => {
    const entry = find(id)
    entry.down = down
    peer.last().notify('litch/harness/status/changed', { harness: id, info: infoOf(entry) })
  }
  return { core, fake: fake.device, peer, time, logs, side, device, command, sent, set }
}
