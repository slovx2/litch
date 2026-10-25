// 回答的 Markdown 切记号（src/transcript/markdown-lex.ts）：删除线只认两个波浪号，一个的照原样是字。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { lex } = await import('../src/transcript/markdown-lex.ts')

const inline = (source) => lex(source)[0].tokens.map((token) => [token.type, token.raw])

test('单个波浪号写范围不是删除线，两个的照旧是', () => {
  assert.deepEqual(inline('等级太高（147~155级），比两个123级号高出25~30级，~~真删~~'), [
    ['text', '等级太高（147~155级），比两个123级号高出25~30级，'],
    ['del', '~~真删~~'],
  ])
  assert.deepEqual(inline('~单~'), [['text', '~单~']])
  // 删除线里面的字照旧解析
  assert.deepEqual(
    lex('~~**粗**~~')[0].tokens[0].tokens.map((token) => token.type),
    ['strong'],
  )
})
