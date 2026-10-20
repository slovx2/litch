// 登录后的保存提示（prompts.mts）和密码库为它加的几样（比对、暂存加密、保存、永不名单）：
// 提交之后导航完成才出提示、提示里没有密码、没导航就不出、过期丢掉、库里一样的不提示、不一样的提示更新、
// 点保存才存、点“永不”记进名单之后不再提示、从名单里去掉之后又会提示。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TabInfo } from '../model.mjs'
import { createSavePrompts, SAVED_SOURCE } from '../passwords/prompts.mjs'
import { createPasswordStore, type PasswordCipher, passwordsFile } from '../passwords/store.mjs'

/** 可逆的假加密：密文里看不出明文 */
const cipher: PasswordCipher = {
  available: () => true,
  encrypt: (plain) => Buffer.from([...plain].reverse().join(''), 'utf8').toString('base64'),
  decrypt: (sealed) => [...Buffer.from(sealed, 'base64').toString('utf8')].reverse().join(''),
}

const tab = (id = 't1'): TabInfo => ({
  id,
  owner: { deviceId: 'local', threadId: 'thread-a' },
  kind: 'agent',
  url: 'https://bank.example/login',
  title: 'Sign in',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  agentActive: true,
  keep: false,
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'litch-prompts-'))
  let clock = 1_800_000_000_000
  const now = () => clock
  const store = createPasswordStore({ file: passwordsFile(dir), cipher, now })
  const prompts = createSavePrompts({ store, now })
  const pushed: unknown[] = []
  prompts.onChange((list) => pushed.push(list))
  return {
    dir,
    store,
    prompts,
    pushed,
    tick: (ms: number) => {
      clock += ms
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const ORIGIN = 'https://bank.example'

test('提交之后导航完成才出提示，提示里没有密码；点保存才存', () => {
  const { store, prompts, pushed, dir, done } = setup()
  try {
    assert.equal(prompts.capture(7, tab(), ORIGIN, 'ann', 'hunter2-secret'), true)
    assert.deepEqual(prompts.list(), [])
    prompts.navigated(7, false)
    assert.deepEqual(prompts.list(), [])
    prompts.loaded(7)
    const [prompt] = prompts.list()
    assert.ok(prompt)
    assert.equal(prompt.kind, 'save')
    assert.equal(prompt.tabId, 't1')
    assert.equal(prompt.threadId, 'thread-a')
    assert.equal(JSON.stringify(pushed).includes('hunter2'), false)
    assert.equal(JSON.stringify(prompts.list()).includes('hunter2'), false)
    // 没人答之前什么都没存
    assert.equal(store.list().length, 0)
    assert.equal(prompts.answer(prompt.id, 'save'), true)
    assert.equal(prompts.list().length, 0)
    const [saved] = store.list()
    assert.equal(saved?.username, 'ann')
    assert.equal(saved?.source, SAVED_SOURCE)
    assert.deepEqual(store.reveal(saved?.id ?? '', ORIGIN), {
      username: 'ann',
      password: 'hunter2-secret',
    })
    assert.equal(readFileSync(passwordsFile(dir), 'utf8').includes('hunter2'), false)
    assert.equal(prompts.answer(prompt.id, 'save'), false)
  } finally {
    done()
  }
})

test('单页应用：同一页里换地址就算导航完成', () => {
  const { prompts, done } = setup()
  try {
    prompts.capture(7, tab(), ORIGIN, 'ann', 'pw-1')
    prompts.navigated(7, true)
    assert.equal(prompts.list().length, 1)
  } finally {
    done()
  }
})

test('没导航（多半是登录没成）、提交太久之后才导航、标签没了：都不出提示', () => {
  const { prompts, tick, done } = setup()
  try {
    prompts.capture(7, tab(), ORIGIN, 'ann', 'pw-1')
    prompts.loaded(7)
    assert.deepEqual(prompts.list(), [])
    tick(61_000)
    prompts.navigated(7, true)
    assert.deepEqual(prompts.list(), [])
    prompts.capture(8, tab('t2'), ORIGIN, 'ann', 'pw-1')
    prompts.tabGone(8)
    prompts.navigated(8, true)
    assert.deepEqual(prompts.list(), [])
    // 空密码不算
    assert.equal(prompts.capture(9, tab(), ORIGIN, 'ann', ''), false)
  } finally {
    done()
  }
})

test('没人理的提示到点丢掉，从不自动保存', () => {
  const { store, prompts, tick, done } = setup()
  try {
    prompts.capture(7, tab(), ORIGIN, 'ann', 'pw-1')
    prompts.navigated(7, true)
    tick(31 * 60_000)
    assert.deepEqual(prompts.list(), [])
    assert.equal(store.list().length, 0)
  } finally {
    done()
  }
})

test('库里一样的不提示，密码不一样的提示更新，点了换掉密码', async () => {
  const { store, prompts, done } = setup()
  try {
    await store.importMany(
      [{ origin: ORIGIN, username: 'ann', password: 'old-pw', store: 'profile' }],
      'chrome:Default',
    )
    assert.equal(store.compare(ORIGIN, 'ann', 'old-pw'), 'same')
    assert.equal(prompts.capture(7, tab(), ORIGIN, 'ann', 'old-pw'), false)
    assert.equal(prompts.capture(7, tab(), ORIGIN, 'ann', 'new-pw'), true)
    prompts.navigated(7, true)
    const [prompt] = prompts.list()
    assert.equal(prompt?.kind, 'update')
    prompts.answer(prompt?.id ?? '', 'save')
    const [only] = store.list()
    assert.equal(store.list().length, 1)
    assert.equal(only?.source, 'chrome:Default')
    assert.deepEqual(store.reveal(only?.id ?? '', ORIGIN)?.password, 'new-pw')
  } finally {
    done()
  }
})

test('不保存就只是关掉；“这个网站永不”记进名单，之后不再提示，去掉之后又会提示', () => {
  const { store, prompts, done } = setup()
  try {
    prompts.capture(7, tab(), ORIGIN, 'ann', 'pw-1')
    prompts.navigated(7, true)
    prompts.answer(prompts.list()[0]?.id ?? '', 'dismiss')
    assert.equal(store.list().length, 0)
    assert.deepEqual(store.neverSites(), [])

    prompts.capture(7, tab(), ORIGIN, 'ann', 'pw-1')
    prompts.navigated(7, true)
    prompts.answer(prompts.list()[0]?.id ?? '', 'never')
    assert.deepEqual(
      store.neverSites().map((one) => one.origin),
      [ORIGIN],
    )
    assert.equal(prompts.capture(7, tab(), ORIGIN, 'bob', 'pw-2'), false)
    // 全删密码不动永不名单
    store.removeAll()
    assert.equal(store.isNever(ORIGIN), true)
    assert.equal(store.removeNever(ORIGIN), true)
    assert.equal(store.removeNever(ORIGIN), false)
    assert.equal(prompts.capture(7, tab(), ORIGIN, 'bob', 'pw-2'), true)
  } finally {
    done()
  }
})

test('同一个网站同一个用户名的新提示换掉旧的', () => {
  const { prompts, done } = setup()
  try {
    prompts.capture(7, tab(), ORIGIN, 'ann', 'pw-1')
    prompts.navigated(7, true)
    prompts.capture(7, tab(), ORIGIN, 'ann', 'pw-2')
    prompts.navigated(7, true)
    assert.equal(prompts.list().length, 1)
  } finally {
    done()
  }
})

test('加密器不可用：不暂存、不提示', () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-prompts-'))
  try {
    const store = createPasswordStore({
      file: passwordsFile(dir),
      cipher: { ...cipher, available: () => false },
    })
    const prompts = createSavePrompts({ store })
    assert.equal(prompts.capture(7, tab(), ORIGIN, 'ann', 'pw-1'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
