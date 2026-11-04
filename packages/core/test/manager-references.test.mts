import assert from 'node:assert/strict'
import test from 'node:test'
import {
  managerReferenceIds,
  managerReferencesResolver,
  mapManagerMarkdown,
} from '../src/manager-references.mjs'

test('编号涵盖决策、事项、请求、报告和建议，路径和不存在的编号不误链', async () => {
  const ids = managerReferenceIds('#D-72 #I-2 #R-3 #P-4 #S-abc-def #D-999 feat/D-72 AD-72')
  assert.deepEqual(ids, ['D-72', 'I-2', 'R-3', 'P-4', 'S-abc-def', 'D-999'])
  let calls = 0
  const resolve = managerReferencesResolver(async (ids) => {
    calls++
    return ids.filter((id) => id !== 'D-999')
  })
  assert.deepEqual([...(await resolve(ids))], ids.slice(0, -1))
  await resolve(ids)
  assert.equal(calls, 1)
})

test('代码块、缩进代码、行内代码、显式链接和未闭合围栏不处理', () => {
  const text =
    '#D-1\n```ts\n#D-2\n```\n~~~\n#D-3\n~~~\n    #D-4\n`#D-5` ``#D-6`` [#D-7](https://example.com)\n```\n#D-8'
  const found: string[] = []
  assert.equal(
    mapManagerMarkdown(text, (part) => {
      found.push(...managerReferenceIds(part))
      return part
    }),
    text,
  )
  assert.deepEqual(found, ['D-1'])
})
