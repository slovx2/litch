// mermaid 代码块前面插的那行说明（src/detail/mermaid.ts）
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { labelMermaid } from '../src/detail/mermaid.ts'

test('mermaid 块前面插一行说明，别的代码块和块里的字不动', () => {
  const text = [
    '看图：',
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
    '',
    '```ts',
    'const a = 1',
    '```',
  ].join('\n')
  assert.equal(
    labelMermaid(text, 'mermaid · 在桌面端看图'),
    [
      '看图：',
      '*mermaid · 在桌面端看图*',
      '',
      '```mermaid',
      'flowchart LR',
      '  A --> B',
      '```',
      '',
      '```ts',
      'const a = 1',
      '```',
    ].join('\n'),
  )
})

test('别的代码块里写着的 ```mermaid 不算；没有 mermaid 的原样返回', () => {
  const nested = ['````md', '```mermaid', 'x', '```', '````'].join('\n')
  assert.equal(labelMermaid(nested, 'L'), nested)
  assert.equal(labelMermaid('普通的话', 'L'), '普通的话')
})
