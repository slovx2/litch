// 正式手机界面 + 延迟分页看板，检查所有类别的可见性和错误/空列表；不接真实设备。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, until } from './chrome-m0/cdp.mjs'
import { installManagerBoardMobileFixture } from './manager-board-mobile-fixture.mjs'

const measure = process.argv.includes('--measure')
const output = process.env.LITCH_CONSOLE_SHOTS ?? join(process.cwd(), '.artifacts/mobile-console')
mkdirSync(output, { recursive: true })
const root = mkdtempSync(join(tmpdir(), 'console-visible-'))
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
assert.ok(binary)
const preview = await installManagerBoardMobileFixture({ issues: true })
let child, cdp, inspectFailure
const errors = []
try {
  child = spawn(
    binary,
    [
      '--headless=new',
      `--user-data-dir=${root}/profile`,
      '--remote-debugging-port=0',
      '--use-mock-keychain',
      '--password-store=basic',
      'about:blank',
    ],
    {
      env: { HOME: root, PATH: '/usr/bin:/bin', TMPDIR: root },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let log = ''
  child.stderr.on('data', (chunk) => {
    log += chunk
  })
  cdp = await Cdp.connect(
    await until(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], 'Chrome'),
  )
  const target = (await cdp.call('Target.getTargets')).targetInfos.find((t) => t.type === 'page')
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const call = (method, params) => cdp.call(method, params, sessionId)
  const read = async (expression) => {
    const value = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails))
    return value.result.value
  }
  inspectFailure = () => read('document.body.innerText.slice(0, 5000)')
  cdp.listeners.add((event) => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params)
  })
  await call('Runtime.enable')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  })
  const selector = (id) => `[data-testid=${JSON.stringify(id)}]`
  const tap = async (id) => {
    await until(() => read(`!!document.querySelector(${JSON.stringify(selector(id))})`), id, 60000)
    await read(`document.querySelector(${JSON.stringify(selector(id))}).click()`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const inspect = () =>
    read(`(()=>{
    const e=document.querySelector('[data-testid="manager-board-scroll"]');
    if(!e)return null; const r=e.getBoundingClientRect();let opacity=1;
    for(let p=e;p;p=p.parentElement) opacity*=Number(getComputedStyle(p).opacity);
    return {opacity,height:r.height,text:e.innerText,cards:e.querySelectorAll('[data-testid^="issue-card:"]').length};
  })()`)
  await call('Page.navigate', {
    url: `${preview.url}/?app=1&scene=manager-console&lang=zh-CN&skin=retro&appearance=dark`,
  })
  await until(
    () => read(`!!document.querySelector('[data-testid="issue-list"]')`),
    'issue数据到达',
    90000,
  )
  const first = await inspect()
  console.log('FIRST', JSON.stringify(first))
  writeFileSync(
    join(output, 'first.png'),
    Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  )
  if (!measure) assert.ok(first.opacity > 0 && first.height > 100, '分页数据已到，列表却不可见')
  for (const kind of ['decision', 'request', 'report', 'suggestion', 'ordinary']) {
    await tap(`issue-capsule:${kind}`)
    const state = await inspect()
    console.log(kind, JSON.stringify(state))
    if (!measure) {
      assert.ok(state.opacity > 0 && state.height > 100)
      assert.ok(state.text.trim(), '必须显示条目、加载、错误或空状态')
      assert.equal(await read(`!!document.querySelector('[data-testid="issue-status-row"]')`), true)
    }
  }
  for (const mode of ['empty', 'error', 'board-error', 'loading', 'normal']) {
    await read(`globalThis.__managerBoardFixture.change(${JSON.stringify(mode)})`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const state = await inspect()
    console.log(mode, JSON.stringify(state))
    if (!measure) {
      assert.ok(state.opacity > 0 && state.text.trim())
      assert.equal(await read(`!!document.querySelector('[data-testid="issue-status-row"]')`), true)
      if (mode === 'error') assert.match(state.text, /列表读取失败/)
      if (mode === 'board-error') assert.match(state.text, /看板读取失败/)
      if (mode === 'empty')
        assert.equal(await read(`!!document.querySelector('[data-testid="issue-empty"]')`), true)
    }
  }
  await tap('manager-tab:chat')
  await tap('manager-tab:console')
  await tap('issue-capsule:decision')
  const returned = await inspect()
  console.log('RETURN', JSON.stringify(returned))
  if (!measure) assert.ok(returned.opacity > 0 && returned.cards > 0)
  writeFileSync(
    join(output, 'returned.png'),
    Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  )
  assert.deepEqual(errors, [], '不能吞掉渲染异常')
  console.log('截图', output)
} catch (error) {
  console.error('页面诊断', await inspectFailure?.(), JSON.stringify(errors))
  throw error
} finally {
  cdp?.close()
  child?.kill()
  await preview.close()
}
