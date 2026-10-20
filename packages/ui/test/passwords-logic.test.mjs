// 设置页“已保存的密码”的判断（src/settings/passwords-logic.ts）：排序、搜索、来源的写法。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { filterPasswords, sortPasswords, sourceLabel } = await import(
  '../src/settings/passwords-logic.ts'
)

const one = (origin, username, source = 'chrome:Default') => ({
  id: `${origin}|${username}`,
  origin,
  username,
  source,
  createdAt: 1,
})

const LIST = [
  one('https://mail.example.com', 'zoe'),
  one('http://localhost:3000', 'dev'),
  one('https://bank.example.com', 'ann@example.com'),
  one('https://bank.example.com', 'Bob'),
]

test('按站点排（https 的按主机名），同站点按用户名', () => {
  assert.deepEqual(
    sortPasswords(LIST).map((item) => `${item.origin} ${item.username}`),
    [
      'https://bank.example.com ann@example.com',
      'https://bank.example.com Bob',
      'http://localhost:3000 dev',
      'https://mail.example.com zoe',
    ],
  )
})

test('搜索站点或用户名：不分大小写，几个词都要对得上', () => {
  assert.equal(filterPasswords(LIST, '').length, 4)
  assert.equal(filterPasswords(LIST, '  ').length, 4)
  assert.deepEqual(
    filterPasswords(LIST, 'BANK').map((item) => item.username),
    ['ann@example.com', 'Bob'],
  )
  assert.deepEqual(
    filterPasswords(LIST, 'bank bob').map((item) => item.username),
    ['Bob'],
  )
  assert.deepEqual(filterPasswords(LIST, 'nothing'), [])
})

test('来源写成产品名加资料名', () => {
  assert.equal(sourceLabel('chrome:Default'), 'Chrome · Default')
  assert.equal(sourceLabel('firefox:abcd.default-release'), 'Firefox · abcd.default-release')
  assert.equal(sourceLabel('edge:'), 'Edge')
  assert.equal(sourceLabel('safari:x'), 'safari:x')
  assert.equal(sourceLabel('manual'), 'manual')
})

const { SAVED_HERE, sortNever } = await import('../src/settings/passwords-logic.ts')
const { promptsFor } = await import('../src/side/browser/save-prompt-logic.ts')

test('从不保存的网站：最近加的在前', () => {
  assert.deepEqual(
    sortNever([
      { origin: 'https://a.example', at: 1 },
      { origin: 'https://c.example', at: 3 },
      { origin: 'https://b.example', at: 3 },
    ]).map((one) => one.origin),
    ['https://b.example', 'https://c.example', 'https://a.example'],
  )
  assert.equal(SAVED_HERE, 'litch')
})

test('面板上的保存提示：只出这个会话的，新的在前', () => {
  const prompt = (id, threadId, at, deviceId = 'local') => ({
    id,
    deviceId,
    threadId,
    tabId: 't1',
    origin: 'https://bank.example',
    username: 'ann',
    kind: 'save',
    at,
  })
  const all = [
    prompt('a', 's1', 1),
    prompt('b', 's2', 2),
    prompt('c', 's1', 3),
    prompt('d', 's1', 4, 'build'),
  ]
  assert.deepEqual(
    promptsFor(all, { deviceId: 'local', threadId: 's1' }).map((one) => one.id),
    ['c', 'a'],
  )
  assert.deepEqual(promptsFor(all, { deviceId: 'local', threadId: '' }), [])
})
