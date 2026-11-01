import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanSubagentMetadata } from '../src/server-helpers.mjs'

test('子代理只清理正文边界的已知运行时元数据', () => {
  assert.equal(
    cleanSubagentMetadata(
      '<tools-used-before-summary>Read</tools-used-before-summary>\n\n正文\n<usage>42</usage>',
    ),
    '正文',
  )
  assert.equal(
    cleanSubagentMetadata(
      '<system-reminder>内部提示</system-reminder>\n<tools-used-after-summary>Read</tools-used-after-summary>\n正文',
    ),
    '正文',
  )
  for (const text of [
    '正文里的 <usage>42</usage>',
    '```xml\n<usage>42</usage>\n```',
    '<example>用户 XML</example>',
    '开头\n<usage>示例</usage>\n结尾',
    '<usage>未闭合',
  ])
    assert.equal(cleanSubagentMetadata(text), text)
})
