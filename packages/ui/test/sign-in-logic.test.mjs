// 登录卡片上的判断（src/side/browser/sign-in-logic.ts）：来源怎么拆出可注册域名、预检原因认不认得、过期还剩几分钟。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { knownBlock, minutesLeft, originParts } = await import(
  '../src/side/browser/sign-in-logic.ts'
)

const joined = (parts) => `${parts.lead}${parts.main}${parts.tail}`

test('来源突出可注册域名，拼回去就是原来的来源', () => {
  const cases = [
    ['https://accounts.google.com', 'https://accounts.', 'google.com', ''],
    ['https://github.com', 'https://', 'github.com', ''],
    ['https://a.b.example.co.uk', 'https://a.b.', 'example.co.uk', ''],
    ['https://login.example.com.cn:8443', 'https://login.', 'example.com.cn', ':8443'],
    ['http://127.0.0.1:3000', 'http://', '127.0.0.1', ':3000'],
    ['http://localhost:5199', 'http://', 'localhost', ':5199'],
    ['https://co.uk', 'https://', 'co.uk', ''],
  ]
  for (const [origin, lead, main, tail] of cases) {
    const parts = originParts(origin)
    assert.deepEqual(parts, { lead, main, tail }, origin)
    assert.equal(joined(parts), origin)
  }
})

test('认不出的来源整个放在中间', () => {
  assert.deepEqual(originParts('not a url'), { lead: '', main: 'not a url', tail: '' })
})

test('预检原因：认得的原样回，认不出的是 null', () => {
  assert.equal(knownBlock('insecure'), 'insecure')
  assert.equal(knownBlock('verification'), 'verification')
  assert.equal(knownBlock('origin_changed'), 'origin_changed')
  assert.equal(knownBlock('something_new'), null)
})

test('过期倒计时按分钟往上取整，过了是 0', () => {
  assert.equal(minutesLeft(30 * 60_000, 0), 30)
  assert.equal(minutesLeft(61_000, 0), 2)
  assert.equal(minutesLeft(1, 0), 1)
  assert.equal(minutesLeft(5, 5), 0)
  assert.equal(minutesLeft(5, 9), 0)
})
