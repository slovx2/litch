import assert from 'node:assert/strict'
import test from 'node:test'
import type { ManagerDecision } from '../../protocol/src/manager.mjs'
import {
  type ManagerBoardSummary,
  type ManagerObjectPage,
  type ManagerPageQuery,
  MANAGER_PAGING_METHOD as METHOD,
} from '../../protocol/src/manager-paging.mjs'
import { ChannelError } from '../src/channel/protocol.mjs'
import { createManagers, type ManagersHost } from '../src/device/manager.mjs'
import { PagedManagerBoard } from '../src/device/manager-paging.mjs'
import { sampleManagers } from '../src/mock/sample-manager.mjs'
import type { ManagerBoardTopicView } from '../src/model-manager.mjs'

function fixture() {
  const sample = sampleManagers('local', 1_800_000_000, 'zh-CN')
  const manager = sample.managers[0]
  const template = sample.boards[0]?.decisions[0]
  assert.ok(manager)
  assert.ok(template)
  const decisions = Array.from({ length: 65 }, (_, i) => ({
    ...template,
    id: `D-${i + 1}` as const,
    status: 'open' as const,
  })) as ManagerDecision[]
  const calls: { method: string; params: any }[] = []
  const page = (query: ManagerPageQuery, offset = 0): ManagerObjectPage => {
    const matches =
      query.kind === 'decision'
        ? decisions.filter((d) => query.status === 'all' || query.status === d.status)
        : []
    return {
      query,
      total: matches.length,
      nextCursor: offset + 30 < matches.length ? String(offset + 30) : null,
      entries: matches.slice(offset, offset + 30).map((d) => ({
        id: d.id,
        kind: 'decision',
        title: d.title,
        preview: '',
        status: d.status,
        pending: d.status === 'open',
        revision: d.revision,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
    }
  }
  const summary = (): ManagerBoardSummary => ({
    manager,
    situation: null,
    counts: {
      decision: {
        all: decisions.length,
        open: decisions.filter((d) => d.status === 'open').length,
        pending: decisions.filter((d) => d.status === 'open').length,
        answered: decisions.filter((d) => d.status === 'answered').length,
      },
      request: {},
      report: {},
      suggestion: {},
      item: {},
    },
    initial: page({ kind: 'decision', status: 'open', order: 'newest' }),
    activities: [],
    lines: { lines: [], checkedAt: null, failed: 0 },
  })
  let summaryGate: Promise<void> | null = null
  const host: ManagersHost = {
    deviceId: 'local',
    online: () => true,
    supported: () => true,
    features: () => ({ feedback: true, ignore: true, posts: true, paging: true }),
    changed() {},
    log() {},
    fail: (error) => new ChannelError('internal', String(error)),
    request: (async (method: string, params: any) => {
      calls.push({ method, params })
      switch (method) {
        case METHOD.catalog:
          return { managers: [manager] }
        case METHOD.summary: {
          const result = structuredClone(summary())
          await summaryGate
          return { summary: result }
        }
        case METHOD.page:
          return structuredClone(page(params, Number(params.cursor ?? 0)))
        case METHOD.detail:
          return {
            object: structuredClone(decisions.find((d) => d.id === params.id)),
            post: null,
            relations: [],
            previousClosed: null,
            reopened: null,
          }
        case METHOD.history:
          return { changes: [], nextCursor: null }
        case METHOD.lines:
          return { lines: [], checkedAt: null, failed: 0 }
        default:
          throw new Error(`意外调用 ${method}`)
      }
    }) as ManagersHost['request'],
  }
  return {
    host,
    calls,
    decisions,
    manager,
    gate(value: Promise<void> | null) {
      summaryGate = value
    },
  }
}

test('分页首屏不用旧整板；详情、历史按需；对账只重读已加载页', async () => {
  const f = fixture()
  let view: Pick<ManagerBoardTopicView, 'board' | 'paging'> = { board: null }
  const service = new PagedManagerBoard(f.host, f.manager.id, (next) => {
    view = next
  })
  await service.refresh()
  assert.deepEqual(
    f.calls.map((c) => c.method),
    [METHOD.summary],
  )
  assert.equal(view.board?.decisions.length, 0)
  assert.equal(view.paging?.pages['decision/open/newest']?.entries.length, 30)
  const query = { kind: 'decision', status: 'open', order: 'newest' } as const
  await Promise.all([service.page(query, true), service.page(query, true)])
  assert.equal(view.paging?.pages['decision/open/newest']?.entries.length, 60)
  assert.equal(f.calls.filter((c) => c.method === METHOD.page).length, 1)
  await service.detail('D-1')
  assert.equal(view.board?.decisions.length, 1)
  const first = f.decisions[0]
  assert.ok(first)
  assert.equal(view.board?.decisions[0]?.createdAt, first.createdAt * 1000)
  assert.equal(
    f.calls.some((c) => c.method === METHOD.history),
    false,
  )
  await service.history('D-1')
  f.calls.length = 0
  await service.refresh()
  assert.deepEqual(
    f.calls.map((c) => c.method).sort(),
    [METHOD.summary, METHOD.page, METHOD.detail, METHOD.history].sort(),
  )
  assert.equal(view.paging?.pages['decision/open/newest']?.entries.length, 60)
})

test('成功回包立即移出待定并改总数；在途旧摘要不覆盖回包，新摘要仅一次补读', async () => {
  const f = fixture()
  let view: Pick<ManagerBoardTopicView, 'board' | 'paging'> = { board: null }
  const snapshots: ManagerBoardTopicView['paging'][] = []
  const service = new PagedManagerBoard(f.host, f.manager.id, (next) => {
    view = next
    snapshots.push(structuredClone(next.paging))
  })
  await service.refresh()
  await service.detail('D-1')
  let release = () => {}
  f.gate(
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  const reading = service.refresh()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const first = f.decisions[0]
  assert.ok(first)
  const accepted = {
    ...first,
    status: 'answered' as const,
    revision: first.revision + 1,
  }
  f.decisions[0] = accepted
  service.accepted([accepted])
  assert.equal(view.paging?.summary.counts.decision.open, 64)
  assert.equal(
    view.paging?.pages['decision/open/newest']?.entries.some((head) => head.id === 'D-1'),
    false,
  )
  const after = snapshots.length
  release()
  f.gate(null)
  await reading
  assert.equal(view.paging?.summary.counts.decision.open, 64)
  assert.ok(
    snapshots.slice(after).every((snapshot) => snapshot?.summary.counts.decision.open === 64),
  )
  assert.equal(view.board?.decisions[0]?.status, 'answered')
})

test('核心能力协商走新目录；旧设备仍调用 list 和 board/read', async () => {
  const f = fixture()
  const service = createManagers(f.host)
  const close = service.openBoard(f.manager.id, { snapshot() {}, delta() {}, error() {} } as never)
  service.resync()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(f.calls.some((call) => call.method === METHOD.catalog))
  assert.ok(f.calls.some((call) => call.method === METHOD.summary))
  assert.ok(
    f.calls.every(
      (call) => !['litch/manager/list', 'litch/manager/board/read'].includes(call.method),
    ),
  )
  close()
  service.offline()
})

test('桌面通知观察所有开放头字段，能发现第一页之外重新打开的决策', async () => {
  const f = fixture()
  f.manager.contact.desktopNotification = true
  const opened: string[] = []
  const service = createManagers(f.host)
  const close = service.open({
    snapshot() {},
    delta(operations: any[]) {
      for (const operation of operations)
        if (operation.op === 'manager.decisionOpened') opened.push(operation.decision.id)
    },
  } as never)
  service.resync()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(opened, [])
  const reads = f.calls.filter((call) => call.method === METHOD.summary).length
  const closeBoard = service.openBoard(f.manager.id, { snapshot() {}, delta() {} } as never)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(
    f.calls.filter((call) => call.method === METHOD.summary).length,
    reads,
    '打开页面复用通知观察器的分页快照',
  )
  const last = f.decisions[64]
  assert.ok(last)
  last.status = 'answered'
  last.revision++
  service.notification('litch/manager/board/changed', { managerId: f.manager.id })
  await new Promise((resolve) => setTimeout(resolve, 30))
  last.status = 'open'
  last.revision++
  service.notification('litch/manager/board/changed', { managerId: f.manager.id })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(opened, ['D-65'])
  closeBoard()
  close()
  service.offline()
})

test('完整待定首页已包含答复结果时复用在途对账，不重复读取', async () => {
  const f = fixture()
  f.decisions.length = 20
  const service = new PagedManagerBoard(f.host, f.manager.id, () => {})
  await service.refresh()
  await service.detail('D-1')
  const before = f.decisions[0]
  assert.ok(before)
  const accepted = { ...before, status: 'answered' as const, revision: before.revision + 1 }
  f.decisions[0] = accepted
  let release = () => {}
  f.gate(
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  f.calls.length = 0
  const reading = service.refresh()
  await new Promise((resolve) => setTimeout(resolve, 0))
  service.accepted([accepted])
  release()
  f.gate(null)
  await reading
  assert.equal(f.calls.filter((call) => call.method === METHOD.summary).length, 1)
})

test('另一已加载页已经见到更高版本时，迟到答复不能倒退列表或计数', async () => {
  const f = fixture()
  let view: Pick<ManagerBoardTopicView, 'board' | 'paging'> = { board: null }
  const service = new PagedManagerBoard(f.host, f.manager.id, (next) => {
    view = next
  })
  await service.refresh()
  await service.detail('D-1')
  const first = f.decisions[0]
  assert.ok(first)
  f.decisions[0] = { ...first, revision: first.revision + 2 }
  await service.page({ kind: 'decision', status: 'all', order: 'newest' })
  service.accepted([{ ...first, revision: first.revision + 1, status: 'answered' }])
  assert.equal(view.paging?.summary.counts.decision.open, 65)
  assert.equal(view.paging?.pages['decision/all/newest']?.entries[0]?.revision, first.revision + 2)
})
