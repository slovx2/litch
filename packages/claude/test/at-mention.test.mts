// 提到的文件、文件夹交给 Claude Code 的写法：路径里有空白时加引号，文件夹的斜杠原样留着（CLI 按它认目录）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { atMention, textFromInput } from '../src/util.mjs'

test('@ 写法：普通路径不加引号，有空白的加引号，带引号的路径不再包', () => {
  assert.equal(atMention('/w/docs/'), '@/w/docs/')
  assert.equal(atMention('/Users/me/My Docs/'), '@"/Users/me/My Docs/"')
  assert.equal(atMention('/w/a "b".md'), '@/w/a "b".md')
})

test('输入里的 mention 化成正文里的 @ 写法', () => {
  const text = textFromInput([
    { type: 'text', text: '看看' },
    { type: 'mention', name: 'My Docs', path: '/Users/me/My Docs/' },
  ])
  assert.match(text, /@"\/Users\/me\/My Docs\/"/)
})
