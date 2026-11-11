// 正式控制台与抽屉的隔离浏览器验收；--baseline 记录修改前的重复正文，不修改真实经理数据。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const baseline = process.argv.includes('--baseline')
const evidence = process.env.LITCH_DRAWER_EVIDENCE
const root = mkdtempSync(join(tmpdir(), 'nebula-issue-drawer-'))
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
const server = await createServer({
  root: new URL('../packages/ui', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 0, hmr: false },
  logLevel: 'error',
})
let browser, cdp
try {
  await server.listen()
  browser = spawn(
    binary,
    withChromiumTestArgs([
      '--headless=new',
      `--user-data-dir=${root}/profile`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--window-size=1200,940',
      'about:blank',
    ]),
    {
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let log = ''
  browser.stderr.on('data', (chunk) => {
    log += chunk
  })
  cdp = await Cdp.connect(
    await until(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], 'Chrome'),
  )
  const target = (await cdp.call('Target.getTargets')).targetInfos.find(
    (one) => one.type === 'page',
  )
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const call = (method, params) => cdp.call(method, params, sessionId)
  await call('Runtime.enable')
  await call('Page.enable')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1200,
    height: 940,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('litch.managerDiscussionPane', JSON.stringify({height:400}))`,
  })
  const read = async (expression) => {
    const value = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description)
    return value.result.value
  }
  const wait = (selector) =>
    until(() => read(`!!document.querySelector(${JSON.stringify(selector)})`), selector)
  const click = async (selector) => {
    await wait(selector)
    await read(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  await call('Page.navigate', {
    url: `${server.resolvedUrls.local[0]}test/issue-drawer-fixture.html`,
  })
  await click('article[data-issue="D-1"] [data-act="issue-toggle"]')
  await click('[data-act="issue-discuss"]')
  await wait('.mg-talk-pane [data-issue-thread="pane"] textarea')
  await read('window.__litchLook.set({skin:"human",theme:"dark"})')
  if (baseline) {
    assert.equal(await read('!!document.querySelector(".mg-talk-pane .mg-issue-quick")'), true)
  } else {
    assert.equal(
      await read(
        'document.querySelectorAll(".mg-talk-pane [data-issue-original],.mg-talk-pane .mg-issue-quick").length',
      ),
      0,
    )
    assert.equal(
      await read('document.querySelector(".mg-talk-pane").innerText.includes("只在完成时提示")'),
      true,
    )
  }
  if (evidence) {
    mkdirSync(evidence, { recursive: true })
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const shot = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(
      join(evidence, baseline ? 'before.png' : 'after.png'),
      Buffer.from(shot.data, 'base64'),
    )
  }
  if (!baseline) {
    await click('article [data-act="issue-toggle"]')
    await click('.mg-talk-head [data-act="discussion-body"]')
    await until(
      () =>
        read(
          'document.querySelector("article [data-act=issue-toggle]").getAttribute("aria-expanded")==="true" && document.activeElement.matches("article")',
        ),
      '查看正文定位并展开卡片',
    )
    assert.equal(
      await read('document.querySelectorAll(".mg-talk-pane [data-issue-original]").length'),
      0,
    )
    await read('window.__issueDrawer.hide()')
    await wait('[data-issue-empty]')
    assert.equal(
      await read('document.querySelectorAll(".mg-talk-pane [data-issue-original]").length'),
      0,
    )
    await click('.mg-talk-head [data-act="discussion-body"]')
    await wait('.mg-talk-pane [data-issue-original] .mg-issue-quick')
    await read('window.__issueDrawer.show()')
    await until(
      () => read('document.querySelectorAll(".mg-talk-pane [data-issue-original]").length===0'),
      '列表恢复后不重复正文',
    )
    await read('window.__issueDrawer.hide()')
    await wait('[data-issue-empty]')
    await click('.mg-talk-head [data-act="discussion-body"]')
    await wait('.mg-talk-pane [data-issue-original]')
    await click('.mg-talk-head [data-act="discussion-body"]')
    assert.equal(
      await read('document.querySelectorAll(".mg-talk-pane [data-issue-original]").length'),
      0,
    )
    await click('[data-act="discussion-close"]')
    await read('window.__issueDrawer.open()')
    await wait('.mg-talk-pane textarea')
    assert.equal(
      await read('document.querySelectorAll(".mg-talk-pane [data-issue-original]").length'),
      0,
    )
  }
  console.log(
    baseline
      ? 'BASELINE：抽屉重复背景与选项'
      : 'PASS：讨论不重复正文、查看正文定位展开、过滤掉后就地折叠、重开默认收起',
  )
} finally {
  cdp?.close()
  if (browser && browser.exitCode === null) {
    const exited = new Promise((resolve) => browser.once('exit', resolve))
    browser.kill()
    await exited
  }
  await server.close()
  rmSync(root, { recursive: true, force: true })
}
