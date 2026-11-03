// 先构建 device；node scripts/bench-manager-paging.mjs 夹具JSON [规模倍数] [输出JSON]
import { readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { managerPagingRig } from './manager-paging-rig.mjs'

const data = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const scale = Number(process.argv[3] ?? 1)
const { env, owner, manager, lineReads } = managerPagingRig(data, scale)
const times = {}
const measure = async (name, run) => {
  const start = performance.now()
  const result = await run()
  ;(times[name] ??= []).push(performance.now() - start)
  return result
}
try {
  let summary
  let full
  for (let i = 0; i < 7; i++) {
    summary = await measure('summary', () => owner.paging.summary(manager.id))
    await measure('catalog', () => owner.paging.call('litch/manager/catalog/read', {}))
    await measure('serializeSummary', () => JSON.stringify({ summary }))
    await measure('historyPage', () => owner.paging.queries.history(manager.id, 'D-1'))
    full = await measure('board', () =>
      owner.call('litch/manager/board/read', { managerId: manager.id }, true),
    )
    await measure('list', () => owner.call('litch/manager/list', {}, true))
    await measure('serializeBoard', () => JSON.stringify(full))
  }
  const plans = {
    heads: owner.store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT rowid,id,json_extract(body,'$.title') FROM objects WHERE manager_id=? AND id LIKE 'D-%' AND rowid<=? AND json_extract(body,'$.status')='open' ORDER BY json_extract(body,'$.createdAt') DESC,rowid DESC LIMIT 31",
      )
      .all(manager.id, 1e9),
    history: owner.store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT seq,body FROM changes WHERE manager_id=? AND seq<=? AND seq<? AND json_extract(body,'$.objectId')=? ORDER BY seq DESC LIMIT 31",
      )
      .all(manager.id, 1e9, 1e9, 'D-1'),
  }
  const report = {
    scale,
    objects: 160 * scale,
    changes: 2400 * scale,
    bytes: {
      board: Buffer.byteLength(JSON.stringify(full)),
      summary: Buffer.byteLength(JSON.stringify({ summary })),
    },
    times: Object.fromEntries(
      Object.entries(times).map(([key, samplesMs]) => [
        key,
        { medianMs: [...samplesMs].sort((a, b) => a - b)[3], samplesMs },
      ]),
    ),
    lineReads: lineReads(),
    plans,
  }
  console.log(JSON.stringify(report, null, 2))
  if (process.argv[4]) writeFileSync(process.argv[4], JSON.stringify({ report, summary }))
} finally {
  await env.close()
}
