// 回答的 Markdown 切记号（src/transcript/markdown-lex.ts）：删除线只认两个波浪号，一个的照原样是字。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const { lex } = await import('../src/transcript/markdown-lex.ts')

const inline = (source) => lex(source)[0].tokens.map((token) => [token.type, token.raw])

const cases = JSON.parse(readFileSync(new URL('./fixtures/cjk-emphasis.json', import.meta.url)))
const descendants = (tokens) =>
  tokens.flatMap((token) => [token, ...descendants(token.tokens ?? [])])
const content = (token) => token.tokens?.map(content).join('') ?? token.text ?? ''

for (const { source, kind, text, href, count = 1 } of cases) {
  test(`中文强调与语法边界：${source}`, () => {
    const tokens = lex(source)
    const nodes = descendants(tokens)
    if (kind === 'text') {
      assert.equal(tokens.map(content).join(''), text)
      assert.ok(!nodes.some((node) => ['strong', 'em', 'del'].includes(node.type)))
    } else {
      const matches = nodes.filter((node) => node.type === kind)
      assert.equal(matches.length, count)
      assert.equal(content(matches[0]), text)
      if (href) assert.equal(matches[0].href, href)
      if (['code', 'codespan', 'link'].includes(kind))
        assert.ok(!nodes.some((node) => ['strong', 'em', 'del'].includes(node.type)))
    }
  })
}

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
