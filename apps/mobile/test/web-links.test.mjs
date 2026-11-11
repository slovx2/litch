import assert from 'node:assert/strict'
import { test } from 'node:test'
import { performWebLinkAction, webLinkActions } from '../src/ui/web-links.ts'

test('手机没有内置浏览器，网页长按菜单只有复制和系统浏览器；文件、编号及危险协议不接管', () => {
  assert.deepEqual(webLinkActions('HTTPS://atlas.example.invalid/a'), [
    { id: 'copyLink', label: 'link.menu.copy' },
    { id: 'openSystem', label: 'link.menu.system' },
  ])
  for (const url of [
    'litch-file:fictional',
    'litch-issue:I-1',
    '/workshop/notes.md',
    'javascript:alert(1)',
    'mailto:fictional@example.invalid',
  ])
    assert.deepEqual(webLinkActions(url), [])
})

test('菜单把完整 URL 写入剪贴板或交给系统，保留查询和片段；失败传回界面', async () => {
  const url = 'https://atlas.example.invalid/a?q=hello%20world#part'
  const calls = []
  const io = {
    copy: async (value) => {
      calls.push(['copy', value])
      return true
    },
    open: async (value) => {
      calls.push(['open', value])
    },
  }
  await performWebLinkAction('copyLink', url, io)
  await performWebLinkAction('openSystem', url, io)
  assert.deepEqual(calls, [
    ['copy', url],
    ['open', url],
  ])
  await performWebLinkAction('openSystem', 'javascript:alert(1)', io)
  assert.equal(calls.length, 2)
  await assert.rejects(
    performWebLinkAction('copyLink', url, { ...io, copy: async () => false }),
    /clipboard/,
  )
})
