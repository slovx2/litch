import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markdownSearchText } from '../src/transcript/search/markdown.ts'
import { searchWindow } from '../src/transcript/turn-window.ts'

test('搜索文本按实际 Markdown 节点连接，保留代码/链接标签，不搜隐藏的地址', () => {
  assert.equal(markdownSearchText('跨**节点**匹配'), '跨节点匹配')
  assert.equal(markdownSearchText('[界面文字](https://hidden.test)'), '界面文字')
  assert.equal(markdownSearchText('```ts\nconst needle = "中文"\n```'), 'const needle = "中文"')
  assert.ok(markdownSearchText('|列|\n|-|\n|内容|').includes('内容'))
})

test('远距离跳转只加目标附近回合，保持顺序；不把中间一万回合一次挂载', () => {
  const turns = Array.from({ length: 10_000 }, (_, i) => `t${i}`)
  assert.deepEqual(searchWindow(turns, 't1', 4), [
    't0',
    't1',
    't2',
    't9996',
    't9997',
    't9998',
    't9999',
  ])
  assert.deepEqual(searchWindow(turns, 'gone', 4), turns.slice(-4))
})
