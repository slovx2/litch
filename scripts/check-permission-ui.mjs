// 隔离 headless Chrome + 权限核心；模拟旧设备和临时超时，不保存截图或操作日用浏览器。
// 先安装根目录与 packages/ui 依赖，运行 node scripts/check-permission-ui.mjs。
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
const work = mkdtempSync(join(tmpdir(), 'litch-permission-browser-'))
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
  for (const device of ['old', 'timeout']) {
    for (const width of [320, 500, 900]) {
      await cdp.call(
        'Page.navigate',
        {
          url: `http://127.0.0.1:${uiPort}/test/permission-fixture.html?device=${device}&width=${width}`,
        },
        sessionId,
      )
      await until(() => read('!!window.permissionProbe?.state().view'), '权限状态')
      for (const skin of ['retro', 'standard', 'human']) {
        await read(`window.__litchLook.set({skin: '${skin}'})`)
        const state = await read(`(() => {
          const bar = document.querySelector('.cmp-bar')
          const rects = [...bar.children].map(e => e.getBoundingClientRect())
          return { ...window.permissionProbe.state(), text: bar.innerText,
            height: bar.getBoundingClientRect().height,
            centers: rects.map(r => r.top + r.height / 2),
            overflow: bar.scrollWidth - bar.clientWidth,
            wrap: getComputedStyle(bar).flexWrap }
        })()`)
        console.log(JSON.stringify({ device, width, skin, ...state }))
        if (process.argv.includes('--before')) continue
        assert.doesNotMatch(state.text, /读取失败|↻|未能|升级/)
        assert.equal(state.wrap, 'nowrap')
        assert.ok(Math.max(...state.centers) - Math.min(...state.centers) <= 1, '底栏保持单行')
        assert.ok(state.overflow <= 1, '窄底栏不把发送键挤出可视范围')
        if (device === 'old') assert.equal(state.requests, 0)
        // 省略后的选择器仍可打开；完全访问确认不被静默降级绕过。
        await read(`document.querySelector('[data-kind="permission"] .pick-btn').click()`)
        await until(() => read('!!document.querySelector(".pick-list")'), '权限菜单')
        await read(`document.querySelector('.pick-list [aria-selected="true"]').click()`)
        await until(() => read('!!document.querySelector(".pick-ask")'), '完全访问确认')
        assert.notEqual(
          await read('getComputedStyle(document.querySelector(".pick-ask")).whiteSpace'),
          'nowrap',
        )
        await read(`document.querySelector('.pick-ask .ghost').click()`)
        await read(`document.querySelector('[data-kind="permission"] .pick-btn').click()`)
      }
      if (device === 'timeout' && !process.argv.includes('--before')) {
        await read('window.permissionProbe.reconnect()')
        await until(
          () => read('window.permissionProbe.state().view.record?.permission === ":workspace"'),
          '重连恢复',
        )
        assert.equal(
          await read(
            `document.querySelector('[data-kind="permission"]').innerText.includes("完全访问")`,
          ),
          true,
          '已有会话权限不被记忆覆盖',
        )
      }
    }
  }
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
