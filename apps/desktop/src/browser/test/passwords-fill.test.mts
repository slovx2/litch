// Litch 代填（request_sign_in 的方案 B）里不靠 Electron 的部分：预检规则、同站、自检用的滚动哈希、
// 带着密码的地址怎么重开、打码；登记里的账号、代填和“我自己登录”的回答、手机能答什么、定时任务的过期。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type LoginReport,
  preflight,
  reopenUrl,
  sameSite,
  secretFinder,
  secretProbe,
  siteOf,
  urlHasSecret,
} from '../passwords/fill-rules.mjs'
import { createSignIns, maskUsername, type SignInResolution } from '../passwords/signin.mjs'

const report = (extra: Partial<LoginReport> = {}): LoginReport => ({
  form: 'login',
  hint: 'none',
  visible: true,
  method: 'post',
  action: 'https://example.com/session',
  otp: false,
  ...extra,
})

test('可注册域名和同站', () => {
  assert.equal(siteOf('accounts.google.com'), 'google.com')
  assert.equal(siteOf('login.bbc.co.uk'), 'bbc.co.uk')
  assert.equal(siteOf('localhost'), 'localhost')
  assert.equal(siteOf('127.0.0.1'), '127.0.0.1')
  assert.ok(sameSite('https://a.example.com', 'https://login.example.com'))
  assert.ok(!sameSite('https://example.com', 'https://example.org'))
  assert.ok(!sameSite('http://example.com', 'https://example.com'))
})

test('预检：源、https、表单方法、交去的站、相关窗口、看不看得见、编号提示', () => {
  const ok = {
    frameOrigin: 'https://example.com',
    pageOrigin: 'https://example.com',
    related: false,
  }
  assert.equal(preflight({ ...ok, report: report() }), null)
  // 本机回环的 http 也行，别的 http 不行
  assert.equal(
    preflight({
      frameOrigin: 'http://localhost:3000',
      pageOrigin: 'http://localhost:3000',
      related: false,
      report: report({ action: 'http://localhost:3000/login' }),
    }),
    null,
  )
  assert.equal(
    preflight({
      frameOrigin: 'http://example.com',
      pageOrigin: 'http://example.com',
      related: false,
      report: report(),
    }),
    'insecure',
  )
  // 登录框所在框架的源和卡片上的不一样
  assert.equal(
    preflight({ ...ok, frameOrigin: 'https://evil.example', report: report() }),
    'insecure',
  )
  assert.equal(preflight({ ...ok, report: report({ method: 'get' }) }), 'insecure')
  assert.equal(
    preflight({ ...ok, report: report({ action: 'https://evil.example/steal' }) }),
    'insecure',
  )
  assert.equal(
    preflight({ ...ok, report: report({ action: 'http://example.com/session' }) }),
    'insecure',
  )
  // 同站的子域可以，没有表单的（单页应用）不看方法
  assert.equal(preflight({ ...ok, report: report({ action: 'https://auth.example.com/x' }) }), null)
  assert.equal(preflight({ ...ok, report: report({ method: null, action: null }) }), null)
  assert.equal(preflight({ ...ok, related: true, report: report() }), 'insecure')
  assert.equal(preflight({ ...ok, report: null }), 'no_form')
  assert.equal(preflight({ ...ok, report: report({ form: 'none' }) }), 'no_form')
  assert.equal(preflight({ ...ok, report: report({ form: 'ambiguous' }) }), 'locator_invalid')
  assert.equal(preflight({ ...ok, report: report({ hint: 'invalid' }) }), 'locator_invalid')
  assert.equal(preflight({ ...ok, report: report({ visible: false }) }), 'not_user_visible')
  assert.equal(preflight({ ...ok, report: report({ form: 'username' }) }), null)
})

test('自检的滚动哈希：找得到开头、中间、结尾、多字节的，找不到别的；探针里没有密码', () => {
  let seed = 1
  const random = () => {
    seed = (seed * 48271) % 2147483647
    return seed / 2147483647
  }
  const secret = 'hunter2-秘密!'
  const probe = secretProbe(secret, random)
  assert.ok(!JSON.stringify(probe).includes('hunter'))
  const has = secretFinder(probe)
  assert.ok(has(secret))
  assert.ok(has(`xx${secret}`))
  assert.ok(has(`前面一段${secret}后面`))
  assert.ok(!has('hunter2-秘密?'))
  assert.ok(!has(''))
  assert.ok(!has('hunter2'))
  // 长文字里找
  const long = `${'a'.repeat(200_000)}${secret}${'b'.repeat(1000)}`
  assert.ok(has(long))
  assert.ok(!has('a'.repeat(200_000)))
  // 换一组底数，同样找得到
  assert.ok(secretFinder(secretProbe(secret, random))(`..${secret}..`))
  // 空的探针什么都找不到
  assert.ok(!secretFinder({ length: 0, b1: 1, b2: 1, h1: 0, h2: 0 })('anything'))
})

test('地址里带着密码：原样的、编码过的都认；重开时去掉查询和片段，还带着就只开源', () => {
  const has = secretFinder(secretProbe('p@ss word', Math.random))
  assert.ok(urlHasSecret('https://example.com/?pw=p%40ss+word', has))
  assert.ok(urlHasSecret('https://example.com/?pw=p%40ss%20word', has))
  assert.ok(!urlHasSecret('https://example.com/home', has))
  assert.equal(
    reopenUrl('https://example.com/login?pw=p%40ss%20word#x', has),
    'https://example.com/login',
  )
  assert.equal(reopenUrl('https://example.com/home?a=1', has), 'https://example.com/home?a=1')
  const inPath = secretFinder(secretProbe('topsecret', Math.random))
  assert.equal(reopenUrl('https://example.com/u/topsecret?x', inPath), 'https://example.com')
})

test('打码的用户名', () => {
  assert.equal(maskUsername('someone@gmail.com'), 'so•••@gmail.com')
  assert.equal(maskUsername('ab@x.io'), 'a•••@x.io')
  assert.equal(maskUsername('alice'), 'al•••')
  assert.equal(maskUsername(''), '•••')
})

const owner = { deviceId: 'local', threadId: 'a' }
const input = { owner, tabId: 't1', origin: 'https://example.com', site: 's', reason: 'r' }
const accounts = [
  { entryId: 'e1', username: 'someone@example.com', lastUsed: 10 },
  { entryId: 'e2', username: 'other', lastUsed: null },
]

test('登记：账号用随机 ref 指，条目号不出登记；代填答复给条目号，卡片留着（filling）直到撤', async () => {
  const signIns = createSignIns()
  const one = signIns.begin({ ...input, accounts })
  assert.ok(one)
  const card = signIns.get(one.id)
  assert.ok(card)
  assert.equal(card.stage, 'choose')
  assert.equal(card.accounts.length, 2)
  // 随机的 ref、nonce 里可能碰巧有 e1：按 JSON 里的整个字符串值找
  assert.ok(!JSON.stringify(card).includes('"e1"'))
  assert.equal(card.accounts[0]?.masked, 'so•••@example.com')
  assert.equal(card.accounts[0]?.lastUsed, 10)
  assert.ok(card.nonce.length >= 16)
  // 不认识的 ref、“知道了”不算
  assert.equal(signIns.answer(one.id, { fill: 'nope', remember: false }), false)
  assert.equal(signIns.answer(one.id, 'dismiss'), false)
  const ref = card.accounts[0]?.ref ?? ''
  // 不是定时任务的回合，remember 不算数
  assert.equal(signIns.answer(one.id, { fill: ref, remember: true }), true)
  const resolved = await one.answered
  assert.deepEqual(resolved, { kind: 'fill', ref, entryId: 'e1', remember: false, by: 'desktop' })
  assert.equal(signIns.get(one.id)?.stage, 'filling')
  assert.equal(signIns.get(one.id)?.by, 'desktop')
  // 代填期间什么都答不了
  assert.equal(signIns.answer(one.id, 'cancel'), false)
  signIns.end(one.id)
  assert.equal(signIns.get(one.id), null)
})

test('登记：我自己登录转成 manual，再交还；预检不过不能代填；手机只能代填或拒绝', async () => {
  const signIns = createSignIns()
  const one = signIns.begin({ ...input, accounts, fillBlocked: 'insecure' })
  assert.ok(one)
  const ref = signIns.get(one.id)?.accounts[0]?.ref ?? ''
  assert.equal(signIns.answer(one.id, { fill: ref, remember: false }), false)
  assert.equal(signIns.answer(one.id, 'self', { phoneId: 'p1' }), false)
  assert.equal(signIns.answer(one.id, 'self'), true)
  assert.equal(signIns.get(one.id)?.stage, 'manual')
  assert.equal(signIns.answer(one.id, 'self'), false)
  assert.equal(signIns.answer(one.id, 'done', { phoneId: 'p1' }), false)
  assert.equal(signIns.answer(one.id, 'done'), true)
  assert.deepEqual(await one.answered, { kind: 'done' })

  const two = signIns.begin({ ...input, tabId: 't2', accounts })
  assert.ok(two)
  const ref2 = signIns.get(two.id)?.accounts[1]?.ref ?? ''
  assert.equal(signIns.answer(two.id, { fill: ref2, remember: false }, { phoneId: 'p1' }), true)
  const got = (await two.answered) as Extract<SignInResolution, { kind: 'fill' }>
  assert.equal(got.entryId, 'e2')
  assert.deepEqual(got.by, { phoneId: 'p1' })
  assert.deepEqual(signIns.get(two.id)?.by, { phoneId: 'p1' })

  const three = signIns.begin({ ...input, tabId: 't3', accounts })
  assert.ok(three)
  assert.equal(signIns.answer(three.id, 'cancel', { phoneId: 'p2' }), true)
  assert.deepEqual(await three.answered, { kind: 'cancel', by: { phoneId: 'p2' } })
})

test('登记：定时任务的回合有过期时间，到点还在等人选就过期；人选了自己登录的不过期；勾选只在任务回合算数', async () => {
  const timers: Array<{ run: () => void; ms: number }> = []
  const signIns = createSignIns({
    now: () => 1000,
    schedule: (run, ms) => void timers.push({ run, ms }),
  })
  const one = signIns.begin({ ...input, accounts, taskId: 'task-1', expiresInMs: 30 * 60_000 })
  assert.ok(one)
  assert.equal(signIns.get(one.id)?.expiresAt, 1000 + 30 * 60_000)
  assert.equal(signIns.get(one.id)?.taskId, 'task-1')
  timers.find((one) => one.ms === 30 * 60_000)?.run()
  assert.deepEqual(await one.answered, { kind: 'expired' })
  assert.equal(signIns.list().length, 0)

  const two = signIns.begin({ ...input, accounts, taskId: 'task-1', expiresInMs: 60_000 })
  assert.ok(two)
  signIns.answer(two.id, 'self')
  timers.find((one) => one.ms === 60_000)?.run()
  assert.equal(signIns.get(two.id)?.stage, 'manual')
  signIns.answer(two.id, 'cancel')

  const three = signIns.begin({ ...input, accounts, taskId: 'task-1', expiresInMs: 60_000 })
  assert.ok(three)
  const ref = signIns.get(three.id)?.accounts[0]?.ref ?? ''
  signIns.answer(three.id, { fill: ref, remember: true })
  assert.equal(((await three.answered) as { remember: boolean }).remember, true)

  // 普通会话没有过期时间（给了也不算）
  const four = signIns.begin({ ...input, tabId: 't4', accounts, expiresInMs: 60_000 })
  assert.equal(signIns.get(four?.id ?? '')?.expiresAt, null)
})
