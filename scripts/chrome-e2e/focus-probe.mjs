// 因果对照：真实 headed CFT 的最小化窗口，不激活用户窗口，不保留 profile 或页面证据。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, until } from '../chrome-m0/cdp.mjs'

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
assert.ok(binary?.includes('for Testing'))
const home = mkdtempSync(join(tmpdir(), 'litch-focus-'))
const server = createServer((_req, res) =>
  res.end(`<!doctype html><title>Focus fixture</title>
<button id="click" style="width:120px;height:60px" onclick="this.textContent=String(++window.count)">Count</button>
<input id="field"><button id="next">Next</button><script>window.count=0</script>`),
)
let child, cdp
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  child = spawn(
    binary,
    [
      '--no-startup-window',
      '--remote-debugging-port=0',
      `--user-data-dir=${join(home, 'profile')}`,
      '--use-mock-keychain',
      '--password-store=basic',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
    ],
    {
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let address = ''
  child.stderr.on('data', (data) => {
    address ||= String(data).match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1] ?? ''
  })
  await until(() => address, 'isolated CFT')
  const port = new URL(address).port
  assert.equal(
    execFileSync('/usr/sbin/lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    }).trim(),
    String(child.pid),
  )
  cdp = await Cdp.connect(address)
  const observations = []
  for (const emulation of [false, true, false, true]) {
    const { targetId } = await cdp.call('Target.createTarget', {
      url,
      newWindow: true,
      background: true,
      windowState: 'minimized',
    })
    const { windowId, bounds } = await cdp.call('Browser.getWindowForTarget', { targetId })
    assert.equal(bounds.windowState, 'minimized', 'fixture must remain hidden')
    const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true })
    const send = (method, params) => cdp.call(method, params, sessionId)
    const read = async (expression) =>
      (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value
    await until(() => read('!!document.querySelector("#field")'), 'form')
    const state = () =>
      read(
        '({count:window.count,focus:document.hasFocus(),visibility:document.visibilityState,active:document.activeElement.id||document.activeElement.tagName,value:document.querySelector("#field").value})',
      )
    await send('Emulation.setFocusEmulationEnabled', { enabled: emulation })
    await read(
      'document.activeElement.blur();document.querySelector("#field").value="";window.count=0',
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    const before = await state()
    const rect = await read(
      '(()=>{const r=document.querySelector("#click").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',
    )
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect })
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, ...rect, button: 'left', clickCount: 1 })
    const clicked = await state()
    const tabbed = []
    for (let i = 0; i < 3; i++) {
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Tab',
        code: 'Tab',
        windowsVirtualKeyCode: 9,
      })
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Tab',
        code: 'Tab',
        windowsVirtualKeyCode: 9,
      })
      tabbed.push(await state())
    }
    await read('document.querySelector("#field").focus()')
    await send('Input.insertText', { text: 'fixture' })
    observations.push({ emulation, before, clicked, tabbed, typed: await state() })
    assert.equal(
      (await cdp.call('Browser.getWindowBounds', { windowId })).bounds.windowState,
      'minimized',
    )
    await cdp.call('Target.closeTarget', { targetId })
  }
  for (const observed of observations) {
    assert.equal(observed.clicked.count, observed.emulation ? 1 : 0)
    assert.equal(observed.tabbed[0].active, observed.emulation ? 'field' : 'BODY')
    assert.equal(observed.tabbed[1].active, observed.emulation ? 'next' : 'BODY')
    assert.equal(observed.typed.value, 'fixture')
  }
  console.log(
    JSON.stringify(
      { browser: (await cdp.call('Browser.getVersion')).product, observations },
      null,
      2,
    ),
  )
} finally {
  cdp?.close()
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }
  await new Promise((resolve) => server.close(resolve))
  rmSync(home, { recursive: true, force: true })
}
