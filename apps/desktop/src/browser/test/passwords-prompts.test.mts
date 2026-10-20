// 登录后的保存提示（prompts.mts）和密码库为它加的几样（比对、暂存加密、保存、永不名单）：
// 提交之后导航完成才出提示、提示里没有密码、没导航就不出、过期丢掉、库里一样的不提示、不一样的提示更新、
// 点保存才存、点“永不”记进名单之后不再提示、从名单里去掉之后又会提示。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TabInfo } from '../model.mjs'
import {
  type CapturedLogin,
  createSavePrompts,
  type FrameNavigation,
  SAVED_SOURCE,
  type Schedule,
} from '../passwords/prompts.mjs'
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
  // 手动的定时器：tick 往前拨钟，到点的跑掉
  const timers = new Set<{ at: number; run: () => void }>()
  const schedule: Schedule = (run, ms) => {
    const one = { at: clock + ms, run }
    timers.add(one)
    return () => timers.delete(one)
  }
  const prompts = createSavePrompts({ store, now, schedule })
  const pushed: unknown[] = []
  prompts.onChange((list) => pushed.push(list))
  return {
    dir,
    store,
    prompts,
    pushed,
    timers,
    tick: (ms: number) => {
      clock += ms
      for (const one of [...timers]) {
        if (one.at > clock) continue
        timers.delete(one)
        one.run()
      }
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const ORIGIN = 'https://bank.example'
const login = (username: string, password: string, extra: Partial<CapturedLogin> = {}) => ({
  origin: ORIGIN,
  frame: null,
  username,
  password,
  ...extra,
})
const MAIN: FrameNavigation = { frame: null, inPage: false }
const IN_PAGE: FrameNavigation = { frame: null, inPage: true }

test('提交之后导航完成才出提示，提示里没有密码；点保存才存', () => {
  const { store, prompts, pushed, dir, done } = setup()
  try {
    assert.equal(prompts.capture(7, tab(), login('ann', 'hunter2-secret')), true)
    assert.deepEqual(prompts.list(), [])
    prompts.navigated(7, MAIN)
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
    prompts.capture(7, tab(), login('ann', 'pw-1'))
    prompts.navigated(7, IN_PAGE)
    assert.equal(prompts.list().length, 1)
  } finally {
    done()
  }
})

test('没导航（多半是登录没成）、提交太久之后才导航、标签没了：都不出提示', () => {
  const { prompts, tick, done } = setup()
  try {
    prompts.capture(7, tab(), login('ann', 'pw-1'))
    prompts.loaded(7)
    assert.deepEqual(prompts.list(), [])
    tick(61_000)
    prompts.navigated(7, IN_PAGE)
    assert.deepEqual(prompts.list(), [])
    prompts.capture(8, tab('t2'), login('ann', 'pw-1'))
    prompts.tabGone(8)
    prompts.navigated(8, IN_PAGE)
    assert.deepEqual(prompts.list(), [])
    // 空密码不算
    assert.equal(prompts.capture(9, tab(), login('ann', '')), false)
  } finally {
    done()
  }
})

test('没人理的提示到点丢掉（定时器清，不等人来取），从不自动保存', () => {
  const { store, prompts, pushed, timers, tick, done } = setup()
  try {
    prompts.capture(7, tab(), login('ann', 'pw-1'))
    prompts.navigated(7, IN_PAGE)
    assert.equal(timers.size, 1)
    const before = pushed.length
    tick(31 * 60_000)
    // 到点就推了一次空的给界面
    assert.equal(pushed.length, before + 1)
    assert.deepEqual(pushed.at(-1), [])
    assert.deepEqual(prompts.list(), [])
    assert.equal(store.list().length, 0)
    assert.equal(timers.size, 0)
  } finally {
    done()
  }
})

test('暂存的到点也清掉，之后再导航不出提示', () => {
  const { prompts, timers, tick, done } = setup()
  try {
    prompts.capture(7, tab(), login('ann', 'pw-1'))
    assert.equal(timers.size, 1)
    tick(60_000)
    assert.equal(timers.size, 0)
    prompts.navigated(7, IN_PAGE)
    assert.deepEqual(prompts.list(), [])
  } finally {
    done()
  }
})

test('标签关了，已经出了的提示一起丢', () => {
  const { prompts, pushed, done } = setup()
  try {
    prompts.capture(7, tab('t1'), login('ann', 'pw-1'))
    prompts.navigated(7, IN_PAGE)
    prompts.capture(8, tab('t2'), login('bob', 'pw-2'))
    prompts.navigated(8, IN_PAGE)
    assert.equal(prompts.list().length, 2)
    prompts.tabGone(7)
    assert.deepEqual(
      prompts.list().map((one) => one.username),
      ['bob'],
    )
    assert.deepEqual(
      (pushed.at(-1) as Array<{ username: string }>).map((one) => one.username),
      ['bob'],
    )
  } finally {
    done()
  }
})

test('提示有上限：一个标签 3 条、全部 20 条，多了丢最旧的', () => {
  const { prompts, tick, done } = setup()
  try {
    for (let i = 0; i < 5; i++) {
      prompts.capture(7, tab('t1'), login(`user-${i}`, 'pw'))
      prompts.navigated(7, IN_PAGE)
      tick(10)
    }
    assert.deepEqual(
      prompts.list().map((one) => one.username),
      ['user-2', 'user-3', 'user-4'],
    )
    for (let tabNo = 0; tabNo < 10; tabNo++) {
      for (let i = 0; i < 3; i++) {
        prompts.capture(100 + tabNo, tab(`x${tabNo}`), login(`u${tabNo}-${i}`, 'pw'))
        prompts.navigated(100 + tabNo, IN_PAGE)
        tick(10)
      }
    }
    const all = prompts.list()
    assert.equal(all.length, 20)
    // 最新的那条还在，最早那个标签的都被挤掉了
    assert.ok(all.some((one) => one.username === 'u9-2'))
    assert.equal(
      all.some((one) => one.tabId === 't1'),
      false,
    )
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
    assert.equal(prompts.capture(7, tab(), login('ann', 'old-pw')), false)
    assert.equal(prompts.capture(7, tab(), login('ann', 'new-pw')), true)
    prompts.navigated(7, IN_PAGE)
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
    prompts.capture(7, tab(), login('ann', 'pw-1'))
    prompts.navigated(7, IN_PAGE)
    prompts.answer(prompts.list()[0]?.id ?? '', 'dismiss')
    assert.equal(store.list().length, 0)
    assert.deepEqual(store.neverSites(), [])

    prompts.capture(7, tab(), login('ann', 'pw-1'))
    prompts.navigated(7, IN_PAGE)
    prompts.answer(prompts.list()[0]?.id ?? '', 'never')
    assert.deepEqual(
      store.neverSites().map((one) => one.origin),
      [ORIGIN],
    )
    assert.equal(prompts.capture(7, tab(), login('bob', 'pw-2')), false)
    // 全删密码不动永不名单
    store.removeAll()
    assert.equal(store.isNever(ORIGIN), true)
    assert.equal(store.removeNever(ORIGIN), true)
    assert.equal(store.removeNever(ORIGIN), false)
    assert.equal(prompts.capture(7, tab(), login('bob', 'pw-2')), true)
  } finally {
    done()
  }
})

test('同一个网站同一个用户名的新提示换掉旧的', () => {
  const { prompts, done } = setup()
  try {
    prompts.capture(7, tab(), login('ann', 'pw-1'))
    prompts.navigated(7, IN_PAGE)
    prompts.capture(7, tab(), login('ann', 'pw-2'))
    prompts.navigated(7, IN_PAGE)
    assert.equal(prompts.list().length, 1)
  } finally {
    done()
  }
})

test('加密器不可用：导航完成后出一条“存不了”的说明，只能关掉，不暂存密码', () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-prompts-'))
  try {
    const store = createPasswordStore({
      file: passwordsFile(dir),
      cipher: { ...cipher, available: () => false },
    })
    const prompts = createSavePrompts({ store, schedule: () => () => {} })
    assert.equal(prompts.capture(7, tab(), login('ann', 'pw-1')), true)
    prompts.navigated(7, IN_PAGE)
    const [prompt] = prompts.list()
    assert.equal(prompt?.kind, 'unavailable')
    assert.equal(prompt?.username, 'ann')
    assert.equal(prompts.answer(prompt?.id ?? '', 'save'), false)
    assert.equal(prompts.list().length, 1)
    assert.equal(prompts.answer(prompt?.id ?? '', 'dismiss'), true)
    assert.deepEqual(prompts.list(), [])
    assert.equal(store.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写库失败：抛出给人看的原因，提示留着，能再点', () => {
  const { store, done } = setup()
  try {
    const failing = createSavePrompts({
      store: {
        ...store,
        putSealed: () => {
          throw new Error('disk full')
        },
        addNever: () => {
          throw new Error('disk full')
        },
      },
      schedule: () => () => {},
    })
    failing.capture(7, tab(), login('ann', 'pw-1'))
    failing.navigated(7, IN_PAGE)
    const [stuck] = failing.list()
    assert.throws(() => failing.answer(stuck?.id ?? '', 'save'), /disk full/)
    assert.throws(() => failing.answer(stuck?.id ?? '', 'never'), /disk full/)
    assert.equal(failing.list().length, 1)
    assert.equal(failing.answer(stuck?.id ?? '', 'dismiss'), true)
    assert.deepEqual(failing.list(), [])
  } finally {
    done()
  }
})

test('没有用户名的不提示；两步登录第一步记下的用户名、改密码表单的当前密码能补上', async () => {
  const { store, prompts, done } = setup()
  try {
    assert.equal(prompts.capture(7, tab(), login('', 'pw-1')), false)
    // 两步登录：第一页只交用户名，第二页没有用户名框
    prompts.step(7, ORIGIN, 'two@example.com')
    assert.equal(prompts.capture(7, tab(), login('', 'pw-2')), true)
    prompts.navigated(7, IN_PAGE)
    assert.equal(prompts.list()[0]?.username, 'two@example.com')
    // 别的网站记下的不算
    prompts.step(8, 'https://other.example', 'x@example.com')
    assert.equal(prompts.capture(8, tab('t2'), login('', 'pw-3')), false)

    // 改密码：用户名框藏着没给，拿当前密码在库里认出是 ann，以新密码为准提示更新
    await store.importMany(
      [{ origin: ORIGIN, username: 'ann', password: 'old-pw', store: 'profile' }],
      'chrome:Default',
    )
    assert.equal(store.usernameFor(ORIGIN, 'old-pw'), 'ann')
    assert.equal(prompts.capture(9, tab('t3'), login('', 'new-pw', { current: 'old-pw' })), true)
    prompts.navigated(9, IN_PAGE)
    const update = prompts.list().find((one) => one.tabId === 't3')
    assert.equal(update?.kind, 'update')
    assert.equal(update?.username, 'ann')
    prompts.answer(update?.id ?? '', 'save')
    const saved = store.list().find((one) => one.username === 'ann')
    assert.equal(store.reveal(saved?.id ?? '', ORIGIN)?.password, 'new-pw')
  } finally {
    done()
  }
})

test('只在子框架里完成的登录：那个子框架导航完成就出提示，别的子框架导航不算', () => {
  const { prompts, done } = setup()
  try {
    prompts.capture(7, tab(), login('ann', 'pw-1', { frame: 42 }))
    prompts.navigated(7, { frame: 43, inPage: false })
    prompts.loaded(7)
    assert.deepEqual(prompts.list(), [])
    prompts.navigated(7, { frame: 42, inPage: false })
    prompts.loaded(7)
    assert.equal(prompts.list().length, 1)
    // 子框架里提交、主框架跳走了也算
    prompts.capture(8, tab('t2'), login('bob', 'pw-2', { frame: 42 }))
    prompts.navigated(8, MAIN)
    prompts.loaded(8)
    assert.equal(prompts.list().length, 2)
  } finally {
    done()
  }
})
