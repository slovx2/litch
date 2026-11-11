// 隔离 headless Chrome + 正式核心，浏览器外壳和剪贴板为本地替身。不操作日用浏览器。
// 运行 npm run client:check:link-context-menu；不读取真实 SSH 配置或密钥。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const binary = globSync(
  join(
    homedir(),
    'Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
)
  .sort()
  .at(-1)
if (!binary) throw Error('没有 Chrome for Testing')
const root = fileURLToPath(new URL('..', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'litch-link-menu-'))
const server = createServer()
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
await new Promise((r) => server.close(r))
if (port === 9333) throw Error('禁用端口')
const child = spawn(
  binary,
  withChromiumTestArgs([
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1500,1000',
    'about:blank',
  ]),
  { env: { HOME: work, PATH: '/usr/bin:/bin', TMPDIR: work }, stdio: 'ignore' },
)
const uiReservation = createServer()
await new Promise((r) => uiReservation.listen(0, '127.0.0.1', r))
const uiPort = uiReservation.address().port
await new Promise((r) => uiReservation.close(r))
const ui = spawn(
  process.execPath,
  [
    join(root, 'packages/ui/node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    String(uiPort),
    '--strictPort',
  ],
  { cwd: join(root, 'packages/ui'), stdio: 'ignore' },
)
let cdp
try {
  await until(async () => (await fetch(`http://127.0.0.1:${uiPort}/`)).ok, 'Vite')
  const version = await until(
    async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).json(),
    'ready',
  )
  if (
    execFileSync('/usr/sbin/lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    }).trim() !== String(child.pid)
  )
    throw Error('PID 不符')
  cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  const target = (await cdp.call('Target.getTargets')).targetInfos.find((t) => t.type === 'page')
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const read = async (expression) => {
    const result = await cdp.call(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    )
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  cdp.listeners.add((message) => {
    if (message.method === 'Runtime.exceptionThrown')
      console.error(JSON.stringify(message.params.exceptionDetails))
  })
  await cdp.call('Runtime.enable', {}, sessionId)
  await cdp.call(
    'Page.navigate',
    { url: `http://127.0.0.1:${uiPort}/test/link-context-menu-fixture.html?lang=zh-CN` },
    sessionId,
  )
  await until(() => read("!!document.querySelector('#prose a')"), '正式链接组件', 45000)
  const open = async (selector = '#direct a', x = 200, y = 150) => {
    const prevented = await read(
      `!document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: ${x}, clientY: ${y} }))`,
    )
    assert.equal(prevented, true, '拦下默认右键菜单')
    await until(() => read("!!document.querySelector('[role=menu]')"), '链接菜单')
  }
  const pick = (id) => read(`document.querySelector('[role=menu] [data-action=${id}]').click()`)
  const key = (key) =>
    read(
      `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key: ${JSON.stringify(key)}, bubbles: true, cancelable: true}))`,
    )
  await open()
  assert.deepEqual(
    await read("[...document.querySelectorAll('[role=menu] button')].map(b => b.textContent)"),
    ['复制链接', '在系统浏览器中打开', '在内置浏览器中打开'],
  )
  assert.equal(await read('window.linkFixture.opened.length + window.linkFixture.system.length'), 0)
  await pick('copyLink')
  assert.equal(await read('window.linkFixture.copied.at(-1)'), await read('window.linkFixture.url'))
  await open()
  await pick('openSystem')
  assert.equal(await read('window.linkFixture.system.at(-1)'), await read('window.linkFixture.url'))
  await open()
  await pick('openApp')
  await until(() => read('window.linkFixture.opened.length === 1'), '会话用户标签')
  assert.deepEqual(await read('window.linkFixture.opened[0]'), {
    owner: { deviceId: 'fictional-device', threadId: 'fictional-session' },
    url: await read('window.linkFixture.url'),
  })
  await read("document.querySelector('#direct a').click()")
  await until(() => read('window.linkFixture.opened.length === 2'), '默认点击仍用内置浏览器')
  await read(
    "document.querySelector('#direct a').dispatchEvent(new MouseEvent('auxclick', {button:1,bubbles:true,cancelable:true}))",
  )
  await read(
    "document.querySelector('#direct a').dispatchEvent(new MouseEvent('click', {button:0,metaKey:true,bubbles:true,cancelable:true}))",
  )
  assert.equal(await read('window.linkFixture.system.length'), 3, '中键和 Cmd 点仍用系统浏览器')
  await read(
    "window.litchShell.platform='win32'; document.querySelector('#direct a').dispatchEvent(new MouseEvent('click', {button:0,ctrlKey:true,bubbles:true,cancelable:true})); window.litchShell.platform='darwin'",
  )
  assert.equal(await read('window.linkFixture.system.length'), 4, 'Ctrl 点仍用系统浏览器')
  await open()
  await read('window.linkFixture.enabled(false)')
  await until(
    () => read("document.querySelector('[data-action=openApp]')?.disabled"),
    '设置关闭时置灰',
  )
  assert.match(
    await read("document.querySelector('[data-action=openApp]').textContent"),
    /设置.*关闭/,
  )
  await pick('openApp')
  assert.equal(await read('window.linkFixture.opened.length'), 2)
  await key('ArrowUp')
  assert.equal(await read('document.activeElement.dataset.action'), 'openSystem', '键盘跳过禁用项')
  await key('ArrowDown')
  assert.equal(await read('document.activeElement.dataset.action'), 'copyLink')
  await cdp.call(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
    sessionId,
  )
  await cdp.call(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    sessionId,
  )
  await until(() => read('window.linkFixture.copied.length === 2'), '回车执行复制')
  await open()
  await key('Escape')
  assert.equal(await read("!!document.querySelector('[role=menu]')"), false)
  assert.equal(await read("document.activeElement === document.querySelector('#direct a')"), true)
  await read("document.querySelector('#direct a').click()")
  assert.equal(await read('window.linkFixture.system.length'), 5, '设置关闭后默认点击仍回系统')
  await read('window.linkFixture.enabled(true); window.linkFixture.browser(false)')
  await open()
  assert.equal(await read("document.querySelector('[data-action=openApp]').disabled"), true)
  assert.match(
    await read("document.querySelector('[data-action=openApp]').textContent"),
    /没有内置浏览器/,
  )
  await key('Escape')
  await read('window.linkFixture.browser(true); window.linkFixture.session(false)')
  await open()
  assert.match(
    await read("document.querySelector('[data-action=openApp]').textContent"),
    /没有可用的会话/,
  )
  await key('Escape')
  await read('window.linkFixture.session(true)')
  assert.equal(
    await read("document.querySelectorAll('#prose a').length"),
    2,
    '显式链接和自动网址都经过同一组件',
  )
  for (const selector of ['#prose a', '#prose a:last-child', '#board a', '#docs a']) {
    await open(selector)
    assert.equal(await read("document.querySelectorAll('[role=menu] button').length"), 3)
    await key('Escape')
  }
  await read("document.querySelector('#docs a').click()")
  assert.equal(
    await read('window.linkFixture.system.length'),
    6,
    '文档入口原有系统浏览器点击行为保持',
  )
  await open('#direct a', 1499, 999)
  assert.equal(
    await read(
      "document.querySelector('[role=menu]').getBoundingClientRect().right <= innerWidth - 7",
    ),
    true,
  )
  assert.equal(
    await read(
      "document.querySelector('[role=menu]').getBoundingClientRect().bottom <= innerHeight - 7",
    ),
    true,
  )
  await read('window.linkFixture.enabled(false)')
  await until(
    () =>
      read(
        "document.querySelector('[data-action=openApp]')?.disabled && document.querySelector('[role=menu]').getBoundingClientRect().bottom <= innerHeight - 7",
      ),
    '禁用原因改变高度后仍在窗口内',
  )
  await read("document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}))")
  assert.equal(await read("!!document.querySelector('[role=menu]')"), false)
  await read("document.querySelector('#link-dialog').showModal()")
  await open('#link-dialog a')
  assert.equal(
    await read("document.querySelector('[role=menu]').closest('dialog')?.id"),
    'link-dialog',
  )
  await key('Escape')
  assert.equal(await read("document.querySelector('#link-dialog').open"), true, 'Esc 只关菜单')
  console.log(
    'PASS 网页链接三项菜单、剪贴板接口、当前会话标签、禁用原因、键盘/边界/模态框、正文和自动网址及原有点击路由',
  )
} finally {
  cdp?.close()
  await Promise.all(
    [child, ui].map(
      (process) =>
        new Promise((resolve) => {
          if (process.exitCode !== null) {
            resolve()
            return
          }
          process.once('exit', resolve)
          process.kill('SIGTERM')
        }),
    ),
  )
  rmSync(work, { recursive: true, force: true })
}
