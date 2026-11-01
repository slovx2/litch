// 对着模拟核心的集中建议验收。先起 UI 开发服务器；浏览器无头、用户目录隔离，退出关闭。
// node scripts/check-suggestion-inbox.mjs [http://127.0.0.1:5289]
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const url = process.argv[2] ?? 'http://127.0.0.1:5289'
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
if (!binary) throw new Error('需要 LITCH_CHROME_BINARY 指向 Chrome for Testing')
const work = mkdtempSync(join(tmpdir(), 'litch-suggestions-'))
const output = process.env.LITCH_SUGGESTION_SHOTS ?? join(process.cwd(), '.local/suggestion-inbox')
mkdirSync(output, { recursive: true })
const child = spawn(
  binary,
  [
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--use-mock-keychain',
    '--password-store=basic',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  {
    env: { HOME: work, PATH: '/usr/bin:/bin', TMPDIR: work },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
)
let endpoint = ''
child.stderr.on('data', (chunk) => {
  endpoint += String(chunk)
})
let cdp
try {
  const ws = await until(
    () => endpoint.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1],
    '隔离浏览器',
  )
  assert.ok(
    execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'args='], {
      encoding: 'utf8',
    }).includes(`--user-data-dir=${work}/profile`),
  )
  cdp = await Cdp.connect(ws)
  const target = (await cdp.call('Target.getTargets')).targetInfos.find((t) => t.type === 'page')
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const call = (method, params) => cdp.call(method, params, sessionId)
  const read = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const wait = (selector) =>
    until(() => read(`!!document.querySelector(${JSON.stringify(selector)})`), selector)
  const click = async (selector) => {
    await wait(selector)
    await read(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await new Promise((r) => setTimeout(r, 180))
  }
  const shot = async (name) => {
    await read(
      'document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))',
    )
    const picture = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(output, `M9-${name}.png`), Buffer.from(picture.data, 'base64'))
  }
  const say = async (text) => {
    await wait('.main .dock textarea.cmp-text')
    await read(
      `(()=>{const e=document.querySelector('.main .dock textarea.cmp-text');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    )
    await new Promise((r) => setTimeout(r, 100))
    await read(
      `document.querySelector('.main .dock textarea.cmp-text').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`,
    )
    await wait('.wrap-cards [data-card="proposal"]')
    await until(() => read("!document.querySelector('.main .running-line')"), '回合结束')
  }
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await call('Page.navigate', { url })
  await wait('.sb-btn.suggestions')
  await read("document.querySelector('.onb .ibtn')?.click()")
  await read("window.__litchLook.set({skin:'standard',theme:'light',lang:'zh-CN'})")
  await click('.row-line[data-session="s6"] .ss-row')
  await say('收尾建议')
  await click('.sb-btn.suggestions')
  await wait('.suggestion-row')
  assert.equal(await read("document.querySelectorAll('.suggestion-row').length"), 2)
  await shot('suggestions-zh')
  await read("window.__litchLook.set({lang:'en'})")
  await shot('suggestions-en')
  await click('.suggestion-row [data-act="edit"]')
  await wait('.spawn-dialog')
  await read(
    "document.querySelector('.spawn-dialog').close();document.querySelector('.spawn-dialog').dispatchEvent(new Event('cancel',{cancelable:true}))",
  )
  // 关闭编辑后忽略一张，列表与角标都应随之减少。
  await click('.suggestion-row [data-act="dismiss"]')
  await until(() => read("document.querySelectorAll('.suggestion-row').length === 1"), '忽略移除')
  await read("window.__litchLook.set({lang:'zh-CN'})")
  await click('[data-sidebar-mode="manager"]')
  await click('[data-manager-id="m1"] .mg-pick')
  await wait('[data-board-tab="suggestions"]')
  await shot('manager-entry')
  await click('[data-board-tab="suggestions"]')
  assert.equal(await read("document.querySelectorAll('.suggestion-row').length"), 0)
  // 从经理的工作线产生建议，全局只留一张经理汇总卡；打开后在看板内操作。
  await click('[data-session="manager-k2"] .ss-row')
  await say('收尾建议')
  await click('[data-session="manager-k2"] [aria-haspopup="menu"]')
  await click('[data-action="archive"]')
  await click('.sb-btn.suggestions')
  await wait('[data-suggestion-manager="m1"]')
  assert.equal(
    await read('document.querySelectorAll(\'[data-page="suggestions"] .suggestion-row\').length'),
    1,
  )
  assert.equal(await read("document.querySelectorAll('[data-suggestion-manager]').length"), 1)
  await shot('manager-summary')
  await click('[data-suggestion-manager="m1"] > button')
  await wait('.mg-board .suggestion-row')
  assert.equal(
    await read(
      "document.querySelector('[data-board-tab=\"suggestions\"]').getAttribute('aria-selected')",
    ),
    'true',
  )
  assert.equal(await read("document.querySelectorAll('.mg-board .suggestion-row').length"), 2)
  await click('.mg-board .suggestion-row [data-act="open-source"]')
  await wait('.arch-bar')
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  })
  await wait('.mg-board .suggestion-row')
  assert.equal(
    await read(
      "document.querySelector('[data-board-tab=\"suggestions\"]').getAttribute('aria-selected')",
    ),
    'true',
    '归档预览返回建议页签',
  )
  await click('.mg-board .suggestion-row [data-act="edit"]')
  await wait('.spawn-dialog')
  await read(
    "document.querySelector('.spawn-dialog').close();document.querySelector('.spawn-dialog').dispatchEvent(new Event('cancel',{cancelable:true}))",
  )
  await click('.mg-board .suggestion-row [data-act="dismiss"]')
  await until(
    () => read("document.querySelectorAll('.mg-board .suggestion-row').length === 1"),
    '看板忽略建议',
  )
  await shot('manager-suggestions')

  // 事项与决策共享正式 Markdown，编号、列表、代码、外链均从真实渲染节点核对。
  await click('[data-board-tab="items"]')
  assert.ok(
    await read('!!document.querySelector(\'[data-manager-item="I-2"] .mg-item-reason strong\')'),
  )
  assert.ok(
    await read('!!document.querySelector(\'[data-manager-item="I-2"] .mg-item-reason ul code\')'),
  )
  assert.ok(
    await read(
      '!!document.querySelector(\'[data-manager-item="I-3"] .mg-item-unverified strong\')',
    ),
  )
  await click('[data-manager-item="I-2"] .mg-item-reason [data-board-reference="D-15"]')
  assert.ok(await read('!!document.querySelector(\'[data-decision="D-15"] > .mg-markdown li\')'))
  assert.ok(
    await read('!!document.querySelector(\'[data-decision="D-15"] .mg-option .md strong\')'),
  )
  await click('[data-decision="D-15"] > .mg-markdown [data-board-reference="I-1"]')
  assert.equal(await read("document.activeElement?.getAttribute('data-manager-item')"), 'I-1')
  assert.equal(await read("!!document.querySelector('.mg-foot')"), false)

  const size = async (width) => {
    await call('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await new Promise((r) => setTimeout(r, 200))
  }
  const shown = (selector) =>
    read(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0})()`,
    )
  const widthOf = (selector) =>
    read(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().width`)
  const noOverflow = async () => {
    assert.ok(
      await read(
        "document.querySelector('.mg-board').scrollWidth <= document.querySelector('.mg-board').clientWidth + 1",
      ),
      '看板横向溢出',
    )
    assert.ok(
      await read(
        "document.querySelector('.mg-page').scrollWidth <= document.querySelector('.mg-page').clientWidth + 1",
      ),
      '主区横向溢出',
    )
  }
  await size(1600)
  const originalWidth = await widthOf('.mg-board')
  const grip = await read(
    "(()=>{const r=document.querySelector('.mg-board-grip').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+100}})()",
  )
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...grip,
    button: 'left',
    clickCount: 1,
  })
  await call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: grip.x - 100,
    y: grip.y,
    button: 'left',
    buttons: 1,
  })
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: grip.x - 100,
    y: grip.y,
    button: 'left',
    clickCount: 1,
  })
  await until(async () => (await widthOf('.mg-board')) > originalWidth + 80, '拖动增宽看板')
  const resized = await widthOf('.mg-board')
  await read("document.querySelector('.mg-board-grip').focus()")
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Home',
    code: 'Home',
    windowsVirtualKeyCode: 36,
  })
  await until(async () => Math.abs((await widthOf('.mg-board')) - 360) < 1, '键盘调整到最小宽度')
  await read("window.__litchLook.set({lang:'en'})")
  await noOverflow()
  await shot('board-min-width-en')
  // 切换语言后重新聚焦，并按当前主区可用空间检查宽度上限。
  await read("document.querySelector('.mg-board-grip').focus()")
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'End',
    code: 'End',
    windowsVirtualKeyCode: 35,
  })
  const maximum = Math.min(900, (await widthOf('.mg-page')) - 386)
  await until(async () => {
    const actual = await widthOf('.mg-board')
    if (Math.abs(actual - maximum) < 1) return true
    throw new Error(
      JSON.stringify(
        await read(
          `({actual:${actual},maximum:${maximum},focus:document.activeElement?.outerHTML,saved:localStorage.getItem('litch.managerBoardLayout')})`,
        ),
      ),
    )
  }, '键盘调整到最大宽度')
  await noOverflow()
  const restoreGrip = await read(
    "(()=>{const r=document.querySelector('.mg-board-grip').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+100}})()",
  )
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...restoreGrip,
    button: 'left',
    clickCount: 1,
  })
  await call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: restoreGrip.x + maximum - resized,
    y: restoreGrip.y,
    button: 'left',
    buttons: 1,
  })
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: restoreGrip.x + maximum - resized,
    y: restoreGrip.y,
    button: 'left',
    clickCount: 1,
  })
  await read("window.__litchLook.set({lang:'zh-CN'})")
  await until(async () => Math.abs((await widthOf('.mg-board')) - resized) < 1, '恢复拖动宽度')
  await click('[data-act="manager-board-toggle"]')
  assert.equal(await shown('.mg-board'), false)
  assert.ok(Math.abs((await widthOf('.mg-chat')) - (await widthOf('.mg-page'))) < 1)
  for (const chatWidth of ['compact', 'wide']) {
    await read(`window.__litchLook.set({chatWidth:${JSON.stringify(chatWidth)}})`)
    await shot(`board-collapsed-${chatWidth}`)
    assert.ok(
      await read(
        "document.querySelector('.mg-chat').scrollWidth <= document.querySelector('.mg-chat').clientWidth + 1",
      ),
    )
  }
  await click('[data-act="manager-board-toggle"]')
  assert.ok(Math.abs((await widthOf('.mg-board')) - resized) < 1)
  await call('Page.reload')
  await wait('.sb-btn.suggestions')
  await read("document.querySelector('.onb .ibtn')?.click()")
  await click('[data-sidebar-mode="manager"]')
  await click('[data-manager-id="m1"] .mg-pick')
  await wait('.mg-board-grip')
  assert.ok(Math.abs((await widthOf('.mg-board')) - resized) < 1, '刷新后保留宽度')
  for (const skin of ['standard', 'human', 'retro']) {
    for (const theme of ['light', 'dark']) {
      await read(
        `window.__litchLook.set({skin:${JSON.stringify(skin)},theme:${JSON.stringify(theme)}})`,
      )
      for (const tab of ['items', 'decisions']) {
        await click(`[data-board-tab="${tab}"]`)
        await noOverflow()
        await shot(`board-${tab}-${skin}-${theme}`)
      }
      await click('[data-board-tab="items"]')
      await click('[data-act="manager-board-toggle"]')
      await size(900)
      await click('.mg-narrow button:last-child')
      assert.equal(await shown('.mg-board'), true, '窄窗口不受桌面收起状态影响')
      assert.equal(await shown('.mg-board-grip'), false)
      await noOverflow()
      await shot(`board-narrow-${skin}-${theme}`)
      await click('.mg-narrow button:first-child')
      assert.equal(await shown('.mg-chat'), true)
      assert.equal(await shown('.mg-board'), false)
      await size(1600)
      assert.equal(await shown('.mg-board'), false)
      await click('[data-act="manager-board-toggle"]')
    }
  }
  await read("window.__litchLook.set({skin:'standard',theme:'light',lang:'en'})")
  await click('[data-board-tab="suggestions"]')
  await shot('board-en')
  await read("window.__litchLook.set({lang:'zh-CN'})")
  // 刷新后模拟核心重新开始，在普通会话再生成建议，继续核对来源导航。
  await click('[data-sidebar-mode="chat"]')
  await click('.row-line[data-session="s6"] .ss-row')
  await say('收尾建议')
  await click('.sb-btn.suggestions')
  await wait('.suggestion-row')
  // 来源点击沿用会话导航；不能留在集中页面。
  await click('.suggestion-row .prop-meta button')
  await wait('.row-line[data-session="s6"] .ss-row.sel')
  await click('.sb-settings')
  await click('.set-go[data-page="devices"]')
  await click('.devp-item[data-device="local"] .devp-row')
  const retention = '[data-setting="sessions.suggestionRetentionDays"]'
  await click('[data-sec="group"][data-group="sessions"] .fold')
  await wait(retention)
  await read(
    `document.querySelector(${JSON.stringify(retention)}).scrollIntoView({block:'center'})`,
  )
  assert.deepEqual(
    await read(
      `Array.from(document.querySelector(${JSON.stringify(`${retention} select`)}).options).map(o=>o.value)`,
    ),
    ['1', '3', '7', '14', '30', 'never'],
  )
  await shot('retention')
  console.log(
    '经理看板与集中建议验收通过：汇总卡、看板操作、Markdown 与编号跳转、拖动与收起/恢复、刷新持久化、两档对话宽度、三皮肤明暗及窄窗口、留存枚举。',
  )
} finally {
  cdp?.close()
  const ended = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await ended
  console.log(`隔离浏览器已关闭，临时目录：${work}`)
}
