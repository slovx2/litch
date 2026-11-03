// 正式桌面 App 的会话入口回归，隔离 headless Chrome；先启动指定工作树的 Vite。
// node scripts/check-manager-session-open.mjs http://127.0.0.1:5199
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const base = process.argv[2] ?? 'http://127.0.0.1:5199'
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('只接受回环夹具')
const binary =
  process.env.LITCH_CHROME_BINARY ??
  globSync(
    join(
      homedir(),
      'Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ),
  )
    .sort()
    .at(-1)
if (!binary) throw new Error('缺少隔离 Chrome for Testing')
const work = mkdtempSync(join(tmpdir(), 'litch-manager-open-'))
const browser = spawn(
  binary,
  [
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--password-store=basic',
    '--disable-background-networking',
    '--window-size=1280,900',
    'about:blank',
  ],
  {
    env: { PATH: process.env.PATH, HOME: work, TMPDIR: work },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
)
let output = ''
browser.stderr.on('data', (chunk) => {
  output += chunk
})
let cdp
try {
  const endpoint = await until(
    () => output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1],
    '浏览器',
  )
  cdp = await Cdp.connect(endpoint)
  const page = (await cdp.call('Target.getTargets')).targetInfos.find(
    (entry) => entry.type === 'page',
  )
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: page.targetId,
    flatten: true,
  })
  const call = (method, params) => cdp.call(method, params, sessionId)
  const read = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      )
    return result.result.value
  }
  const run = (fn, ...args) => read(`(${fn.toString()})(...${JSON.stringify(args)})`)
  const has = (selector) => run((s) => !!document.querySelector(s), selector)
  const click = async (selector) => {
    await until(() => has(selector), selector)
    await run((s) => document.querySelector(s).click(), selector)
  }
  const managerPage = '[data-manager="session"][data-manager-id="m1"]'
  const opened = () => until(() => has(managerPage), '经理工作台')
  const open = async (sessionId) => {
    await run((id) => window.__managerOpen.open({ deviceId: 'local', sessionId: id }), sessionId)
  }
  const ordinary = async (id = 's2') => {
    await open(id)
    await until(() => has(`[data-composer-session='["local","${id}"]']`), '普通对话')
    assert.equal(await has(managerPage), false)
  }
  await call('Page.navigate', { url: `${base}/test/manager-open-fixture.html?lang=zh-CN` })
  await until(() => has('[data-projection="recent"] [data-session="m1"]'), '最近经理')
  await click('[data-projection="recent"] [data-session="m1"] .ss-row')
  await opened()
  const shape = () =>
    run(() => ({
      board: !!document.querySelector('.mg-board'),
      chat: !!document.querySelector('.mg-chat'),
      mode: document.querySelector('[data-sidebar-mode="manager"]')?.getAttribute('aria-pressed'),
    }))
  const recent = await shape()
  assert.ok(recent.board && recent.chat, '最近进入完整看板及对话布局')
  await ordinary()
  await click('[data-sidebar-mode="manager"]')
  await click('[data-manager-id="m1"] .mg-pick')
  await opened()
  assert.deepEqual(await shape(), recent, '经理侧栏与最近一致')
  await read(`import('/src/app/actions.ts').then(m=>m.requestManagers({view:'list'}))`)
  await click('[data-manager-row="m1"] .mg-list-open')
  await opened()
  assert.deepEqual(await shape(), recent, '经理目录与最近一致')
  await click('[data-navigation="back"]')
  await until(() => has('[data-manager="list"]'), '返回原入口')
  await click('[data-navigation="forward"]')
  await opened()
  for (const [entry, selector] of [
    ['@ 会话', '[data-open-links] [data-mention="m1"]'],
    ['子会话回报', '[data-open-links] [data-child="m1"] .sev-title'],
  ]) {
    await ordinary()
    if (entry === '子会话回报') await click('[data-open-links] .sev button')
    await click(selector)
    await opened()
    assert.deepEqual(await shape(), recent, entry)
  }
  for (const id of ['session:["local","m1","turn"]', 'manager-decision:["local","m1","D-1"]']) {
    await ordinary()
    await run((id) => window.__managerOpen.notify(id), id)
    await opened()
    assert.deepEqual(await shape(), recent, `通知 ${id.split(':')[0]}`)
  }
  await ordinary()
  await read(`import('/src/search/actions.ts').then(m=>m.requestSearch())`)
  await until(() => has('.search-results [role="option"]'), '标题搜索结果')
  await run(() => {
    const probe = window.__managerOpen
    const summary = probe.store.get(probe.keys.summary('local', 'm1'))
    const title = typeof summary.title === 'string' ? summary.title : summary.title.text
    const row = [...document.querySelectorAll('.search-results [role="option"]')].find((row) =>
      row.textContent.includes(title),
    )
    if (!row) throw new Error(`标题搜索缺经理：${title}`)
    row.click()
  })
  await opened()
  await ordinary('manager-k1')
  await ordinary()
  await run(() => {
    const { store, keys, open } = window.__managerOpen
    const manager = store.get(keys.manager('local', 'm1'))
    const summary = store.get(keys.summary('local', 'm1'))
    const ids = store.get(keys.managerIds('local'))
    window.__restoreManager = () =>
      store.batch(() => {
        store.set(keys.manager('local', 'm1'), manager)
        store.set(keys.managerIds('local'), ids)
        store.set(keys.managersAvailable('local'), true)
        store.set(keys.summary('local', 'm1'), summary)
      })
    store.batch(() => {
      store.delete(keys.manager('local', 'm1'))
      store.set(
        keys.managerIds('local'),
        ids.filter((id) => id !== 'm1'),
      )
      store.set(keys.managersAvailable('local'), null)
      const { litchManager, ...plain } = summary
      store.set(keys.summary('local', 'm1'), plain)
    })
    open({ deviceId: 'local', sessionId: 'm1' })
  })
  assert.equal(
    await has('[data-composer-session=\'["local","m1"]\']'),
    false,
    '未知身份不先画普通经理对话',
  )
  await run(() => window.__restoreManager())
  await opened()
  assert.deepEqual(await shape(), recent, '迟到目录后仍是同一工作台')
  await ordinary()
  await run(() => {
    const { store, keys, open } = window.__managerOpen
    store.batch(() => {
      store.delete(keys.manager('local', 'm1'))
      store.set(
        keys.managerIds('local'),
        store.get(keys.managerIds('local')).filter((id) => id !== 'm1'),
      )
      store.set(keys.managersAvailable('local'), null)
    })
    open({ deviceId: 'local', sessionId: 'm1' })
  })
  assert.equal(
    await has('[data-composer-session=\'["local","m1"]\']'),
    false,
    '只有经理标记时等待工作台，不挂普通正文',
  )
  await run(() => window.__restoreManager())
  await opened()
  assert.deepEqual(await shape(), recent, '标记先到与目录先到结果相同')
  await ordinary()
  await run(() => {
    const { store, keys, open } = window.__managerOpen
    store.batch(() => {
      store.delete(keys.manager('local', 'm1'))
      store.set(
        keys.managerIds('local'),
        store.get(keys.managerIds('local')).filter((id) => id !== 'm1'),
      )
      const { litchManager, ...plain } = store.get(keys.summary('local', 'm1'))
      store.set(keys.summary('local', 'm1'), plain)
    })
    open({ deviceId: 'local', sessionId: 'm1', managerId: 'm1' })
  })
  assert.equal(
    await has('[data-composer-session=\'["local","m1"]\']'),
    false,
    '创建应答早于目录和标记时也不挂普通对话',
  )
  await run(() => window.__restoreManager())
  await opened()
  console.log(
    '桌面经理入口检查通过：最近、经理侧栏/目录、返回/前进、@、回报、会话/经理通知、搜索、普通对话/工作线、迟到目录。无截图。',
  )
} finally {
  cdp?.ws.close()
  browser.kill()
}
