// 手工局部基准：先构建 device/core；只用临时库、假引擎和自己生成的看板。
// node scripts/bench-manager-board.mjs [输出 JSON 路径]
import { writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { sampleManagers } from '../packages/core/dist/packages/core/src/mock/sample-manager.mjs'
import { projectManagerBoard } from '../packages/core/dist/packages/core/src/projection/manager.mjs'
import { treeRig } from '../packages/device/dist/device/test/tree-kit.mjs'

const env = treeRig()
const owner = env.device.managers
const sample = sampleManagers('local', 1_800_000_000, 'zh-CN')
const manager = { ...sample.managers[0], harness: 'pi', cwd: env.stateDir }
const paragraph = '这是隔离基准的背景与验收依据，包含范围、实施结果、风险和后续步骤。'.repeat(12)
const times = {}
const count = {}
const measure = async (name, run) => {
  const start = performance.now()
  const value = await run()
  ;(times[name] ??= []).push(performance.now() - start)
  return value
}
const originals = new Map()
for (const key of ['objects', 'changes', 'publishedReports']) {
  const original = owner.store[key].bind(owner.store)
  originals.set(key, original)
  owner.store[key] = (...args) => {
    count[key] = (count[key] ?? 0) + 1
    return original(...args)
  }
}
try {
  owner.store.saveManager(manager)
  owner.store.transaction(() => {
    for (const [kind, amount, template] of [
      ['D', 60, sample.boards[0].decisions[0]],
      ['I', 100, sample.boards[0].items[0]],
    ]) {
      for (let i = 1; i <= amount; i++) {
        let object = {
          ...template,
          id: `${kind}-${i}`,
          title: `隔离看板 ${kind}-${i}`,
          ...(kind === 'D'
            ? { status: i <= 20 ? 'open' : 'answered', background: paragraph }
            : { description: paragraph }),
          createdAt: 1_800_000_000,
          updatedAt: 1_800_000_000,
          revision: 1,
        }
        for (let revision = 2; revision <= 16; revision++) {
          const next = {
            ...object,
            revision,
            title: `隔离看板 ${kind}-${i} 版本 ${revision}`,
            updatedAt: object.updatedAt + 1,
          }
          owner.store.record(manager.id, object.id, 'manager', object, next, '更新依据')
          object = next
        }
        owner.store.saveObject(manager.id, object)
      }
    }
  })
  for (let i = 0; i < 50; i++) {
    env.device.sessionTree.store.addLineage({
      threadId: `bench-line-${i}`,
      parentThreadId: manager.threadId,
      harness: 'pi',
      kind: 'fresh',
      origin: 'model',
      title: `工作线 ${i}`,
      prompt: '隔离工作线',
      wakeParent: false,
      createdAt: 1_800_000_000,
      proposalId: null,
    })
  }
  // 每条会话固定 20ms 假引擎延迟，50 条并行；不接触本机任何真实 harness。
  let lineReads = 0
  env.device.sessionTree.read = async (id) => {
    lineReads++
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { thread: { id, status: { type: 'idle' }, cwd: env.stateDir } }
  }
  let board
  for (let round = 0; round < 5; round++) {
    await measure('listRpc', () => owner.call('litch/manager/list', {}, true))
    const result = await measure('boardRpc', () =>
      owner.call('litch/manager/board/read', { managerId: manager.id }, true),
    )
    board = result.board
    await measure('boardBuild', () => owner.board(manager.id))
    await measure('readChanges', () => originals.get('changes')(manager.id))
    const wire = await measure('serialize', () => JSON.stringify({ board }))
    const decoded = await measure('parse', () => JSON.parse(wire))
    await measure('project', () => projectManagerBoard('local', decoded.board))
  }
  const report = {
    node: process.version,
    size: {
      decisions: board.decisions.length,
      items: board.items.length,
      changes: board.changes.length,
      lines: board.lines.length,
      bytes: Buffer.byteLength(JSON.stringify({ board })),
    },
    times: Object.fromEntries(
      Object.entries(times).map(([key, values]) => [
        key,
        {
          medianMs: [...values].sort((a, b) => a - b)[2],
          samplesMs: values,
        },
      ]),
    ),
    reads: count,
    lineReads,
  }
  console.log(JSON.stringify(report, null, 2))
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ report, board, manager }))
} finally {
  await env.close()
}
