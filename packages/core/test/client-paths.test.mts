// 提到的文件、文件夹：本机设备的文件夹补斜杠、按 mention 带；远程设备开了“操作本机”时写成 <litch-client-paths> 那一段，
// 和提到会话的那一段同时有时排在它前面；先显示的那条和对面回显的一样认出附件。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clientPathsBlock, parseClientPaths } from '../../protocol/src/client-paths.mjs'
import type { MessageExtra, OutgoingMessage } from '../src/model.mjs'
import { projectItem } from '../src/projection/items.mjs'
import { bodyOf, localUserMessage, outgoing, toInput } from '../src/projection/outgoing.mjs'

const folder: MessageExtra = {
  kind: 'file',
  name: 'sa攻略',
  path: '/Users/me/sa攻略',
  folder: true,
  client: true,
}

test('那一段：说明 + 每个路径一行，文件夹补斜杠，尖括号转义；认回来还原', () => {
  const block = clientPathsBlock([
    { path: '/Users/me/sa攻略', folder: true },
    { path: '/Users/me/a<b>.bin', folder: false },
  ])
  assert.ok(block.startsWith('<litch-client-paths>\n'))
  assert.match(block, /litch_machine/)
  assert.match(block, /<path kind="folder">\/Users\/me\/sa攻略\/<\/path>/)
  assert.match(block, /<path kind="file">\/Users\/me\/a&lt;b&gt;\.bin<\/path>/)
  assert.equal(clientPathsBlock([]), '')
  const parsed = parseClientPaths(`看看这个\n\n${block}\n`)
  assert.deepEqual(parsed, {
    rest: '看看这个',
    paths: [
      { path: '/Users/me/sa攻略/', folder: true },
      { path: '/Users/me/a<b>.bin', folder: false },
    ],
  })
  assert.equal(parseClientPaths('没有那一段'), null)
  assert.equal(parseClientPaths('<litch-client-paths>\n说明\n</litch-client-paths>'), null)
})

test('本机设备的文件夹：路径补斜杠、按 mention 带；不收 mention 的写进正文', () => {
  const message = outgoing(
    '看看',
    [],
    [{ kind: 'file', name: 'docs', path: '/w/docs', folder: true }],
  )
  assert.deepEqual(message.extras, [{ kind: 'file', name: 'docs', path: '/w/docs/', folder: true }])
  assert.deepEqual(toInput(message, true), [
    { type: 'text', text: '看看', text_elements: [] },
    { type: 'mention', name: 'docs', path: '/w/docs/' },
  ])
  assert.equal(bodyOf(message, false), '看看\n\n/w/docs/')
  assert.deepEqual(localUserMessage('u1', message, true).attachments, [
    { kind: 'folder', label: 'docs' },
  ])
})

test('这台电脑上的路径：不走 mention，写成那一段，排在提到会话的那一段前面', () => {
  const message: OutgoingMessage = outgoing(
    '看 @[甲]',
    [],
    [folder, { kind: 'session', threadId: 't1', title: '甲' }],
  )
  const input = toInput(message, true)
  assert.equal(input.length, 1)
  const body = bodyOf(message, true)
  assert.ok(body.indexOf('<litch-client-paths>') < body.indexOf('<litch-session-mentions>'))
  assert.match(body, /<path kind="folder">\/Users\/me\/sa攻略\/<\/path>/)
})

test('对话里的条目：先显示的那条和对面回显的一样，那一段化成附件，text 里没有它', () => {
  const message = outgoing('看看这个文件夹', [], [folder])
  const local = localUserMessage('u1', message, true)
  assert.equal(local.text, '看看这个文件夹')
  assert.deepEqual(local.attachments, [{ kind: 'folder', label: '/Users/me/sa攻略/' }])
  const echoed = projectItem(
    {
      type: 'userMessage',
      id: 'u2',
      content: [{ type: 'text', text: bodyOf(message, true), text_elements: [] }],
    } as never,
    false,
  )
  assert.equal(echoed.kind === 'userMessage' && echoed.text, '看看这个文件夹')
  assert.deepEqual(echoed.kind === 'userMessage' && echoed.attachments, [
    { kind: 'folder', label: '/Users/me/sa攻略/' },
  ])
})

test('回显里 mention 的路径以斜杠结尾的画成文件夹', () => {
  const echoed = projectItem(
    {
      type: 'userMessage',
      id: 'u3',
      content: [
        { type: 'text', text: '看', text_elements: [] },
        { type: 'mention', name: 'docs', path: '/w/docs/' },
        { type: 'mention', name: 'a.md', path: '/w/a.md' },
      ],
    } as never,
    false,
  )
  assert.deepEqual(echoed.kind === 'userMessage' && echoed.attachments, [
    { kind: 'folder', label: 'docs' },
    { kind: 'file', label: 'a.md' },
  ])
})
