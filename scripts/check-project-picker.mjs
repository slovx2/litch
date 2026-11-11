// 项目搜索局部验收；先 client:build。--mobile 验正式手机网页预览；全程只用隔离浏览器和模拟核心。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const mobile = process.argv.includes('--mobile')
const kind = mobile ? 'mobile' : 'desktop'
const out = join(root, '.artifacts/project-picker-search')
mkdirSync(out, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'litch-project-search-'))
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
assert.ok(binary, '需要隔离的 Chrome for Testing')
const reservation = createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const server = spawn(
  process.execPath,
  mobile
    ? ['node_modules/expo/bin/cli', 'start', '--web', '--offline', '--port', String(port)]
    : [
        'node_modules/vite/bin/vite.js',
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--strictPort',
      ],
  {
    cwd: join(root, mobile ? 'apps/mobile' : 'packages/ui'),
    env: { ...process.env, CI: '1', EXPO_NO_TYPESCRIPT_SETUP: '1', EXPO_PUBLIC_LITCH_E2E: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
let serverLog = ''
server.stdout.on('data', (data) => {
  serverLog += data
})
server.stderr.on('data', (data) => {
  serverLog += data
})
const browser = spawn(
  binary,
  withChromiumTestArgs([
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    'about:blank',
  ]),
  {
    env: { HOME: work, CODEX_HOME: join(work, 'codex'), PATH: process.env.PATH, TMPDIR: work },
    stdio: 'ignore',
  },
)
const report = { kind, checks: [], exceptions: [] }
let cdp
try {
  await until(async () => (await fetch(`http://127.0.0.1:${port}/`)).ok, '预览服务', 60000)
  const debugPort = await until(
    () => Number(readFileSync(join(work, 'profile/DevToolsActivePort'), 'utf8').split('\n')[0]),
    'Chrome',
  )
  const tabs = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
  cdp = await Cdp.connect(tabs.find((tab) => tab.type === 'page').webSocketDebuggerUrl)
  await cdp.call('Runtime.enable')
  cdp.listeners.add((event) => {
    if (event.method === 'Runtime.exceptionThrown') report.exceptions.push(event.params)
  })
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: mobile ? 390 : 1280,
    height: mobile ? 844 : 900,
    deviceScaleFactor: 1,
    mobile,
  })
  const read = async (expression) => {
    const result = await cdp.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const selector = (id) => `[data-testid="${id}"]`
  const click = async (css) => {
    await until(() => read(`!!document.querySelector(${JSON.stringify(css)})`), css, 60000)
    await read(`document.querySelector(${JSON.stringify(css)}).click()`)
  }
  const key = async (key, code = key) => {
    const windowsVirtualKeyCode = { Enter: 13, Escape: 27, ArrowUp: 38, ArrowDown: 40 }[key]
    await cdp.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode,
      ...(key === 'Enter' ? { text: '\r' } : {}),
    })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
  }
  const write = async (css, value) => {
    await read(`(() => {const field=document.querySelector(${JSON.stringify(css)});field.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)});
      field.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  }
  const shot = async (name) => {
    // 等待 Modal 的淡入动画完成，截图不捕获中间透明度。
    await new Promise((resolve) => setTimeout(resolve, 350))
    const result = await cdp.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(out, `${kind}-${name}.png`), Buffer.from(result.data, 'base64'))
  }
  const open = mobile ? selector('new:project') : '.pick[data-kind="workspace"] .pick-btn'
  const field = mobile ? selector('picker:search') : '.pick[data-kind="workspace"] input'
  const rows = mobile
    ? '[data-testid^="picker:option:"]'
    : '.pick[data-kind="workspace"] .pick-opt:not([data-action])'
  const shown = () =>
    read(`[...document.querySelectorAll(${JSON.stringify(rows)})].map(e=>e.textContent)`)
  const selected = () => read(`document.querySelector(${JSON.stringify(open)}).textContent`)
  for (const device of ['local', 'build']) {
    await cdp.call('Page.navigate', {
      url: `http://127.0.0.1:${port}/?${mobile ? 'app=1&' : ''}lang=zh-CN&onboarding=off`,
    })
    if (mobile) {
      await click(selector(`device:${device}`))
      await click(selector('sessions:new'))
      await click(open)
      await click(selector(`picker:option:${device === 'local' ? 'docs' : 'infra'}`))
      await until(() => read(`!document.querySelector(${JSON.stringify(field)})`), '点选项目')
    } else {
      await click('.pick[data-kind="device"] .pick-btn')
      await click(`.pick[data-kind="device"] [data-option="${device}"]`)
      // 通过正式添加项目入口创建虚构数据，验证名称优先于路径。
      for (const [name, path] of [
        ['Atlas Lab', '/srv/example/nebula'],
        ['Nebula Studio', '/srv/example/studio'],
      ]) {
        await click(open)
        await click('.pick[data-kind="workspace"] [data-action]')
        await until(() => read('!!document.querySelector("#ws-root")'), '项目表单')
        await write('#ws-root', path)
        await write('#ws-name', name)
        await click('.ws-dialog [type="submit"]')
        await until(() => read('!document.querySelector(".ws-dialog")'), '添加完成')
        await until(async () => (await selected()).includes(name), '新项目选中')
      }
    }
    const before = await selected()
    await click(open)
    await until(
      () => read(`document.activeElement===document.querySelector(${JSON.stringify(field)})`),
      '自动聚焦',
    )
    const query = mobile ? (device === 'local' ? 'DOCS' : 'INFRA') : 'NEBULA'
    await write(field, query)
    await until(
      async () => (await shown()).some((text) => text.toLowerCase().includes(query.toLowerCase())),
      '搜索命中',
    )
    if (!mobile) assert.equal((await shown())[0].startsWith('Nebula Studio'), true, '名称命中优先')
    await shot(`${device}-search`)
    await write(field, 'no-such-fictional-project')
    await until(() => read('document.body.innerText.includes("无匹配项")'), '无匹配提示')
    assert.equal(await selected(), before, '未命中不能取消当前选择')
    if (mobile) await click(selector('picker:scrim'))
    else await key('Escape')
    await until(() => read(`!document.querySelector(${JSON.stringify(field)})`), '关闭')
    await click(open)
    await until(
      () => read(`document.querySelector(${JSON.stringify(field)})?.value===''`),
      '重开清空搜索',
    )
    // 路径命中与回车选择；桌面上下键和 Esc 使用真实浏览器键盘事件。
    await write(field, mobile ? (device === 'local' ? '/DOCS' : '/INFRA') : '/EXAMPLE/NEBULA')
    await until(async () => (await shown()).length === 1, '路径命中')
    if (!mobile) {
      await key('ArrowDown')
      assert.equal(await read(`document.activeElement?.matches(${JSON.stringify(rows)})`), true)
      await key('ArrowUp')
      assert.equal(await read('document.activeElement?.matches(".pick-opt")'), true)
      await key('ArrowDown')
      assert.equal(await read(`document.activeElement?.matches(${JSON.stringify(rows)})`), true)
    }
    await key('Enter')
    await until(() => read(`!document.querySelector(${JSON.stringify(field)})`), '回车选择')
    assert.ok(
      (await selected()).includes(
        mobile ? (device === 'local' ? 'docs-site' : 'infra') : 'Atlas Lab',
      ),
    )
    if (mobile) {
      await click(selector('new:where:dir'))
      await write(selector('prompt:input'), '/srv/example/custom')
      await click(selector('prompt:ok'))
      await until(
        () => read('document.body.innerText.includes("/srv/example/custom")'),
        '自定义目录',
      )
      await click(open)
      await click(selector('picker:option::loose'))
      await until(
        () => read('!document.body.innerText.includes("/srv/example/custom")'),
        '切回无项目',
      )
      assert.ok((await selected()).includes('无项目'))
    }
    report.checks.push(
      `${device}：自动聚焦、名称/路径、无匹配保留当前项、关闭/重开、回车选择${mobile ? '、自定义目录切回无项目' : '、名称优先、上下键/Esc'}`,
    )
  }
  assert.deepEqual(report.exceptions, [])
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  if (cdp) {
    writeFileSync(
      join(out, `${kind}-failure.txt`),
      JSON.stringify(
        await cdp.call('Runtime.evaluate', {
          expression: 'document.body.innerText',
          returnByValue: true,
        }),
      ),
    )
    const result = await cdp.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(out, `${kind}-failure.png`), Buffer.from(result.data, 'base64'))
  }
  throw error
} finally {
  writeFileSync(join(out, `${kind}-report.json`), JSON.stringify(report, null, 2))
  writeFileSync(join(out, `${kind}-server.log`), serverLog)
  cdp?.close()
  for (const child of [browser, server]) {
    if (child.exitCode !== null) continue
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill()
    await exited
  }
}
