import assert from 'node:assert/strict'
import test from 'node:test'
import {
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  keys,
  serveChannel,
} from '@litch/core'
import { fakeClock, settle } from '../../../packages/core/test/helpers.mts'
import { catalogCandidates } from '../../../packages/ui/src/composer/session-catalog.ts'
import { sessionHits } from '../../../packages/ui/src/composer/session-hits.ts'
import { sessionTargetOptions } from '../../../packages/ui/src/tasks/session-options.ts'

test('手机从核心全目录生成 @ 和定时目标：经理及工作线可搜索、可选，普通分组仍无经理树', async () => {
  const time = fakeClock()
  const [ui, core] = createPortPair()
  const server = serveChannel(core, createMockCore({ clock: time.clock }), { clock: time.clock })
  const channel = connectChannel(ui)
  const replica = createReplica(channel)
  const stop = replica.start()
  try {
    await settle()
    await settle()
    const catalog = replica.store.get(keys.sessionCatalog('local'))
    const labels = { conversation: '普通对话', child: '子会话', manager: '经理', line: '工作线' }
    const candidates = catalogCandidates(
      catalog,
      [],
      String,
      (kind) => labels[kind],
      new Set(replica.store.get(keys.nativeChildren('local'))),
    )
    const options = sessionTargetOptions(
      [...catalog].sort((a, b) => b.updatedAt - a.updatedAt),
      String,
      (kind) => labels[kind],
      String,
      true,
    )
    for (const id of ['m1', 'manager-k2']) {
      const summary = catalog.find((row) => row.id === id)
      const hits = sessionHits(candidates, {
        query: summary.title,
        current: null,
        workspaceId: null,
        bound: new Set(),
      })
      assert.ok(hits.some((hit) => hit.id === id && hit.typeLabel === labels[summary.kind]))
      assert.ok(
        options.some((option) => option.id === id && option.note.includes(labels[summary.kind])),
      )
      assert.ok(
        !Object.values(replica.store.get(keys.groups('local')))
          .flat()
          .includes(id),
      )
    }
  } finally {
    stop()
    channel.close()
    server()
  }
})
