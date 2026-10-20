import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { transcriptPlanSlug } from '../src/plan-slug.mjs'

test('计划 slug 只认会话记录每行顶层的 slug，取最后一个；工具参数里的同名键不算', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plan-slug-'))
  const path = join(directory, 'session.jsonl')
  try {
    await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'a' })}\n`)
    assert.equal(await transcriptPlanSlug(path, 0), null)
    await writeFile(
      path,
      [
        JSON.stringify({ type: 'user', uuid: 'a', slug: 'old-slug' }),
        JSON.stringify({ type: 'assistant', uuid: 'b', slug: 'real-slug' }),
        // 顶层没有 slug、工具参数里有：不算
        JSON.stringify({
          type: 'assistant',
          uuid: 'c',
          message: { content: [{ type: 'tool_use', input: { slug: 'injected' } }] },
        }),
        '{"half":',
      ].join('\n'),
    )
    assert.equal(await transcriptPlanSlug(path, 0), 'real-slug')
    await writeFile(path, `${JSON.stringify({ slug: '../escape' })}\n`)
    assert.equal(await transcriptPlanSlug(path, 0), null, '不像 slug 的值不认')
    assert.equal(await transcriptPlanSlug(join(directory, 'missing.jsonl'), 0), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
