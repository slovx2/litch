// 正式桌面 App 的会话入口回归，隔离 headless Chrome；先启动指定工作树的 Vite。
// node scripts/check-manager-session-open.mjs http://127.0.0.1:5199
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdtempSync, rmSync } from 'node:fs'
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
const exited = new Promise((resolve) => browser.once('exit', resolve))
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
  const p1Row = '[data-session="p1"]:not(.projection-group *) .ss-row:not(.projection-group *)'
  const p1Composer = '[data-composer-session=\'["local","p1"]\']'
  const catalogAvailable = (available) =>
    run((value) => {
      const { store, keys } = window.__managerOpen
      store.set(keys.managersAvailable('local'), value)
    }, available)
  // 控制到达顺序，不靠启动耗时碰运气：点击已高亮，身份目录仍未就绪。
  await catalogAvailable(null)
  await click(p1Row)
  await until(() => has(`${p1Row}.sel`), '普通会话行高亮')
  assert.equal(await has(p1Composer), false, '行高亮不能证明普通会话正文已打开')
  await click('[data-sidebar-mode="manager"]')
  await catalogAvailable(true)
  await until(() => has(p1Composer), '等待身份期间切树，目录到达后仍打开普通会话')
  assert.ok(await has('[data-sidebar-mode="manager"][aria-pressed="true"]'), '完成打开不切回旧树')
  await click('.tb-side')
  await until(() => has('.tb-side[aria-pressed="true"]'), '普通会话侧面板')
  await click('[data-sidebar-mode="chat"]')
  assert.ok(await has(p1Composer), '切树保留普通会话正文')
  assert.ok(await has(`${p1Row}.sel`), '保留原普通会话选中行')
  assert.ok(await has('.tb-side[aria-pressed="true"]'), '保留原普通会话侧面板')
  await click('[data-sidebar-mode="manager"]')
  await click('[data-manager-id="m1"] .mg-pick')
  await opened()
  await click('[data-board-tab="overview"]')
  await until(() => has('[data-board-tab="overview"][aria-selected="true"]'), '经理概览')
  await click('[data-sidebar-mode="chat"]')
  await opened()
  assert.ok(await has('[data-board-tab="overview"][aria-selected="true"]'), '聊天树保留经理页签')
  await click('[data-sidebar-mode="manager"]')
  await opened()
  assert.ok(await has('[data-board-tab="overview"][aria-selected="true"]'), '保留经理页签')

  // 切树不取消打开；再次选择别的会话才取消上次打开，迟到目录只能完成最后一次选择。
  await click('[data-sidebar-mode="chat"]')
  await ordinary()
  await catalogAvailable(null)
  await click(p1Row)
  await until(() => has(`${p1Row}.sel`), '待确认会话行高亮')
  assert.ok(await has('[data-composer-session=\'["local","s2"]\']'), '原正文仍在')
  await open('s3')
  await click('[data-sidebar-mode="manager"]')
  await catalogAvailable(true)
  await until(() => has('[data-composer-session=\'["local","s3"]\']'), '最后点开的会话完成打开')
  assert.ok(await has('[data-sidebar-mode="manager"][aria-pressed="true"]'), '异步完成仍留当前树')
  await click('[data-sidebar-mode="chat"]')
  assert.equal(await has(p1Composer), false, '迟到目录不能抢回已取消的导航')
  await click('[data-projection="recent"] [data-session="m1"] .ss-row')
  await opened()
  assert.ok(await has('[data-sidebar-mode="chat"][aria-pressed="true"]'), '最近打开经理留在聊天树')
  assert.ok(
    await has('[data-projection="recent"] [data-session="m1"] .ss-row.sel'),
    '经理仍选在最近',
  )
  const shape = () =>
    run(() => ({
      board: !!document.querySelector('.mg-board'),
      chat: !!document.querySelector('.mg-chat'),
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
    '桌面经理入口检查通过：等待身份时切树仍完成打开、再次选择以最后一次为准、切树保留会话/侧面板/看板页签、最近打开经理保留导航树及选中行、经理侧栏/目录、返回/前进、@、回报、通知、搜索、普通对话/工作线、迟到经理目录。无截图。',
  )
} finally {
  cdp?.ws.close()
  browser.kill()
  await exited
  rmSync(work, { recursive: true, force: true })
}
