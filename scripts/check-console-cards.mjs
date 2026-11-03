// 无头浏览器只用模拟核心，结束关闭浏览器和 Vite，不保存截图。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Cdp, until } from './chrome-m0/cdp.mjs'
import { installManagerBoardMobileFixture } from './manager-board-mobile-fixture.mjs'

const repo = resolve(import.meta.dirname, '..')
const root = mkdtempSync(join(tmpdir(), 'console-cards-'))
const mobile = process.argv.includes('--mobile')
const mobileUi = mobile ? await installManagerBoardMobileFixture({ consoleCards: true }) : null
const server = mobile
  ? null
  : spawn(
      process.execPath,
      [
        join(repo, 'packages/ui/node_modules/vite/bin/vite.js'),
        '--host',
        '127.0.0.1',
        '--port',
        '5297',
        '--strictPort',
      ],
      { cwd: join(repo, 'packages/ui'), stdio: 'ignore' },
    )
let browser, cdp
try {
  await until(async () => {
    try {
      return (await fetch(mobileUi?.url ?? 'http://127.0.0.1:5297')).ok
    } catch {
      return false
    }
  }, 'Vite')
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
  browser = spawn(
    binary,
    [
      '--headless=new',
      `--user-data-dir=${root}/profile`,
      '--remote-debugging-port=0',
      '--use-mock-keychain',
      '--password-store=basic',
      '--no-first-run',
      'about:blank',
    ],
    {
      env: { HOME: root, PATH: '/usr/bin:/bin', TMPDIR: root },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let output = ''
  browser.stderr.on('data', (chunk) => (output += chunk))
  cdp = await Cdp.connect(
    await until(() => output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], 'Chrome'),
  )
  const target = (await cdp.call('Target.getTargets')).targetInfos.find((t) => t.type === 'page')
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const call = (method, params) => cdp.call(method, params, sessionId)
  const read = async (expression) => {
    const r = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  await call('Page.enable')
  await call('Page.navigate', {
    url: mobileUi
      ? `${mobileUi.url}/?app=1&scene=manager-console&lang=zh-CN&skin=standard`
      : 'http://127.0.0.1:5297/test/console-cards-fixture.html?lang=zh-CN',
  })
  const wait = (s) => until(() => read(`!!document.querySelector(${JSON.stringify(s)})`), s, 30000)
  const click = async (s) => {
    await wait(s)
    await read(`document.querySelector(${JSON.stringify(s)}).click()`)
    await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  }
  if (mobile) {
    await click('[data-testid="manager-category:request"]')
    await wait('[data-testid="paging-object:R-2"]')
    const selector = '[data-testid="paging-object:R-2"]'
    const top = await read(`document.querySelector('${selector}').getBoundingClientRect().top`)
    await click(selector)
    await wait('[data-testid="manager-issue:R-2"]')
    assert.equal(
      await read(
        `document.querySelector('${selector}').parentElement.contains(document.querySelector('[data-testid="manager-issue:R-2"]'))`,
      ),
      true,
    )
    assert.ok(
      Math.abs(
        top - (await read(`document.querySelector('${selector}').getBoundingClientRect().top`)),
      ) < 2,
    )
    await click('[data-testid="relations:R-2"]')
    await wait('[data-testid="relation:/outside/STORE.md"]')
    assert.equal(
      await read(`document.querySelectorAll('[data-testid="relation:/outside/STORE.md"]').length`),
      1,
    )
    await click('[data-testid="manager-issue:R-2"] textarea')
    assert.equal(await read(`!!document.querySelector('[data-testid="manager-issue:R-2"]')`), true)
    for (const [path, expected] of [
      ['/outside/STORE.md', '隔离文件预览'],
      ['/outside/folder', 'STORE.md'],
      ['/missing', '文件或目录不存在'],
      ['/offline', '设备未连接'],
    ]) {
      await click(`[data-testid="relation:${path}"]`)
      await wait('[data-testid="files"]')
      await until(
        () =>
          read(
            `document.querySelector('[data-testid="files"]').textContent.includes(${JSON.stringify(expected)})`,
          ),
        expected,
      )
      await click('[data-testid="files"] [data-testid="header:back"]')
      await wait('[data-testid="relation:/outside/STORE.md"]')
    }
    await click(selector)
    assert.equal(await read(`!!document.querySelector('[data-testid="manager-issue:R-2"]')`), false)
    console.log('手机正式页面：原位展开、卡头位置、内部控件、链接单处显示通过')
  } else {
    await wait('[data-paging-object="R-2"]')
    const before = await read(
      `document.querySelector('[data-paging-object="R-2"]').getBoundingClientRect().top`,
    )
    await click('[data-paging-object="R-2"] button')
    await wait('[data-manager-request="R-2"]')
    const observed = await read(
      `(()=>{const card=document.querySelector('[data-manager-request="R-2"]');return {inline:!!card.closest('[data-paging-object="R-2"]'),headerY:document.querySelector('[data-paging-object="R-2"]').getBoundingClientRect().top,order:[...document.querySelectorAll('[data-paging-object]')].map(e=>e.dataset.pagingObject),links:[...card.querySelectorAll('[title="/outside/STORE.md"], [data-relation-target="/outside/STORE.md"]')].length}})()`,
    )
    console.log(JSON.stringify({ before, ...observed }))
    if (!process.argv.includes('--reproduce')) {
      assert.equal(observed.inline, true)
      assert.ok(Math.abs(before - observed.headerY) < 2, '展开保持卡头位置')
      assert.deepEqual(observed.order, ['R-1', 'R-2', 'R-3'])
      assert.equal(observed.links, 1, '同一链接只显示一次')
      await click('[data-manager-request="R-2"] textarea')
      assert.equal(
        await read(
          `document.querySelector('[data-paging-object="R-2"] button').getAttribute('aria-expanded')`,
        ),
        'true',
      )
      await click('[data-relation-target="/outside/STORE.md"]')
      assert.equal(await read('window.__consoleCards.file().active'), '/outside/STORE.md')
      await click('[data-relation-target="/outside/folder"]')
      assert.equal(await read('window.__consoleCards.file().revealDirectory'), true)
      for (const [path, message] of [
        ['/missing', '文件或目录不存在'],
        ['/offline', '设备未连接'],
      ]) {
        await click(`[data-relation-target="${path}"]`)
        await until(
          () => read(`document.body.textContent.includes(${JSON.stringify(message)})`),
          message,
        )
        await click('.file-link-dialog .modal-foot button')
      }
      for (const path of ['main', 'abc123']) {
        await click(`[data-relation-target="${path}"]`)
        await wait('.mg-reference-preview')
        await click('.mg-reference-preview button')
      }
      for (const path of ['D-15', 'I-2']) await click(`[data-relation-target="${path}"]`)
      await click('[data-relation-target="manager-k1"]')
      assert.deepEqual(await read('window.__consoleCards.opened'), ['D-15', 'I-2', 'manager-k1'])
      await click('[data-relation-target="https://example.com"] a')
      assert.equal(await read('window.__consoleCards.opened.at(-1)'), 'https://example.com')
      await click('[data-paging-object="R-2"] > button')
      assert.equal(await read('!!document.querySelector("[data-paging-detail]")'), false)
      await read(`document.querySelector('[data-paging-object="R-2"] > button').focus()`)
      for (const [key, code, keyCode] of [
        ['Enter', 'Enter', 13],
        [' ', 'Space', 32],
      ]) {
        await call('Input.dispatchKeyEvent', {
          type: 'keyDown',
          text: key === 'Enter' ? '\r' : ' ',
          key,
          code,
          windowsVirtualKeyCode: keyCode,
        })
        await call('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key,
          code,
          windowsVirtualKeyCode: keyCode,
        })
        await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      }
      assert.equal(
        await read('!!document.querySelector("[data-paging-detail]")'),
        false,
        'Enter 展开、空格收起',
      )
      console.log('控制台原地展开、内部控件、文件/目录/失败提示、Git/看板链接、单处显示通过')
    }
  }
} finally {
  cdp?.close()
  for (const child of [browser, server])
    if (child && child.exitCode === null) {
      child.kill()
      await new Promise((r) => child.once('exit', r))
    }
  await mobileUi?.close()
  rmSync(root, { recursive: true, force: true })
}
