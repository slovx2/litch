// 先起 packages/ui Vite，使用正式核心 manager 服务，隔离浏览器和大看板。
// node scripts/check-manager-board-ui.mjs /tmp/manager-board-after.json [--expect-stale]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, until } from './chrome-m0/cdp.mjs'
import { installManagerBoardMobileFixture } from './manager-board-mobile-fixture.mjs'

const data = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const stale = process.argv.includes('--expect-stale')
const mobile = process.argv.includes('--mobile')
const live = Boolean(data.rpcUrl)
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
const root = mkdtempSync(join(tmpdir(), 'manager-board-ui-'))
const child = spawn(
  binary,
  [
    '--headless=new',
    `--user-data-dir=${root}/profile`,
    '--remote-debugging-port=0',
    '--use-mock-keychain',
    '--password-store=basic',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { env: { HOME: root, PATH: '/usr/bin:/bin', TMPDIR: root }, stdio: ['ignore', 'ignore', 'pipe'] },
)
let output = ''
child.stderr.on('data', (chunk) => {
  output += chunk
})
let cdp
let mobileFixture
try {
  if (mobile) mobileFixture = await installManagerBoardMobileFixture()
  cdp = await Cdp.connect(
    await until(() => output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], '浏览器'),
  )
  const target = (await cdp.call('Target.getTargets')).targetInfos.find((t) => t.type === 'page')
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const call = (method, params) => cdp.call(method, params, sessionId)
  await call('Page.enable')
  await call('Runtime.enable')
  await call('Log.enable')
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `const observer = new MutationObserver(() => {
      const state = window.__managerBoardFixture;
      if (!state?.deliveredAt || !document.querySelector('${mobile ? '[data-testid="manager-issue:D-20"]' : '[data-decision="D-20"]'}')) return;
      observer.disconnect();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.__managerFirstFrame = performance.now() - state.deliveredAt;
      }));
    }); observer.observe(document, {childList:true,subtree:true});`,
  })
  const read = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  cdp.listeners.add((frame) => {
    if (frame.method === 'Runtime.exceptionThrown')
      console.error(JSON.stringify(frame.params.exceptionDetails))
    if (frame.method === 'Log.entryAdded' && frame.params.entry.level === 'error')
      console.error(frame.params.entry.text)
    if (frame.method === 'Fetch.requestPaused')
      void call('Fetch.fulfillRequest', {
        requestId: frame.params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(data)).toString('base64'),
      })
  })
  await call('Fetch.enable', { patterns: [{ urlPattern: '*__manager_board_data*' }] })
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  const wait = (selector) =>
    until(() => read(`!!document.querySelector(${JSON.stringify(selector)})`), selector, 60000)
  const click = async (selector) => {
    await wait(selector)
    await read(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  if (mobile) {
    await call('Emulation.setDeviceMetricsOverride', {
      width: 412,
      height: 915,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await call('Page.navigate', {
      url: `${mobileFixture.url}/?app=1&scene=manager-console&lang=zh-CN&skin=standard&appearance=light`,
    })
    await wait('[data-testid="decision-submit:D-20"]')
    const frameMs = await until(() => read('window.__managerFirstFrame'), '手机首帧')
    await read(
      `(()=>{let e=document.querySelector('[data-testid="manager-issue:D-20"] textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'按此执行');e.dispatchEvent(new Event('input',{bubbles:true}));window.__managerBoardFixture.fail=true})()`,
    )
    await click('[data-testid="decision-submit:D-20"]')
    await until(
      () => read('document.body.textContent.includes("隔离测试：提交失败")'),
      '手机提交失败提示',
    )
    assert.equal(
      await read('document.querySelector(\'[data-testid="manager-issue:D-20"] textarea\').value'),
      '按此执行',
    )
    await read('window.__managerBoardFixture.fail=false')
    await click('[data-testid="decision-submit:D-20"]')
    await until(() => read('window.__managerBoardFixture.submitted'), '手机提交成功')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(
      await read('!!document.querySelector(\'[data-testid="decision-submit:D-20"]\')'),
      stale,
    )
    assert.equal(
      await read(
        'document.querySelector(\'[data-testid="manager-tab:console"]\').getAttribute("aria-selected")',
      ),
      'true',
    )
    await read(
      'document.querySelector(\'[data-testid="manager-issue:D-20"]\').scrollIntoView({block:"center"})',
    )
    const image = `/tmp/manager-board-mobile-${stale ? 'before' : 'after'}.png`
    writeFileSync(
      image,
      Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
    )
    console.log(JSON.stringify({ mobile, stale, frameMs, image }))
  } else {
    await call('Page.navigate', {
      url: `${process.env.LITCH_MANAGER_UI ?? 'http://127.0.0.1:5197'}/test/manager-board-fixture.html?onboarding=off`,
    })
    await wait('[data-sidebar-mode="manager"]')
    await read(
      'document.querySelector(\'[data-act="onboard-close"]\')?.click();window.__litchLook.set({skin:"standard",theme:"light",lang:"zh-CN"})',
    )
    await click('[data-sidebar-mode="manager"]')
    await click('[data-manager-id="m1"] .mg-pick')
    await click('[data-board-tab="inbox"]')
    await wait('[data-decision="D-20"]')
    const frameMs = await until(() => read('window.__managerFirstFrame'), '桌面首帧')
    const historyBefore = await read('document.querySelectorAll(".mg-post-history article").length')
    if (!stale) assert.equal(historyBefore, 0, '未展开的历史不应挂载正文')
    // 历史仍可展开，关闭时不用渲染整段 Markdown。
    await click('[data-decision="D-20"] .mg-post-history summary')
    await wait('[data-decision="D-20"] .mg-post-history article')
    assert.equal(
      await read(
        'document.querySelectorAll(\'[data-decision="D-20"] .mg-post-history article\').length',
      ),
      15,
    )
    await click('[data-decision="D-20"] .mg-post-history summary')
    await read(
      `(()=>{let e=document.querySelector('[data-decision="D-20"] textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'按此执行');e.dispatchEvent(new Event('input',{bubbles:true}));window.__managerBoardFixture.fail=true})()`,
    )
    await until(
      () => read('!document.querySelector(\'[data-act="manager-submit"]\').disabled'),
      '可以提交',
    )
    await click('[data-act="manager-submit"]')
    await until(
      () => read('document.body.textContent.includes("隔离测试：提交失败")'),
      '提交失败提示',
    )
    assert.equal(
      await read('document.querySelector(\'[data-decision="D-20"] textarea\').value'),
      '按此执行',
    )
    await read('window.__managerBoardFixture.fail=false')
    await click('[data-act="manager-submit"]')
    await until(
      () => read('window.__managerBoardFixture.submitted'),
      '提交成功',
      live ? 60000 : 15000,
    )
    if (live)
      await until(() => read('window.__managerBoardFixture.fullPaintAt'), '完整看板落帧', 120000)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(
      await read('!!document.querySelector(\'[data-decision="D-20"]\')'),
      live ? false : stale,
    )
    assert.equal(
      await read('document.querySelector(\'[data-filter="open"]\').getAttribute("aria-pressed")'),
      'true',
    )
    const screenshot = await call('Page.captureScreenshot', { format: 'png' })
    const image = `/tmp/manager-board-ui-${stale ? 'before' : 'after'}.png`
    writeFileSync(image, Buffer.from(screenshot.data, 'base64'))
    console.log(
      JSON.stringify({
        frameMs,
        historyBefore,
        stale,
        image,
        state: await read('window.__managerBoardFixture'),
      }),
    )
  }
} finally {
  cdp?.close()
  child.kill()
  await new Promise((resolve) => child.once('exit', resolve))
  rmSync(root, { recursive: true, force: true })
  await mobileFixture?.close()
}
