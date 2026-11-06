// 正式侧栏的选中工作线状态回归，隔离无头浏览器；先启动指定工作树的 Vite。
// node scripts/check-sidebar-status.mjs http://127.0.0.1:5199
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
  await call('Page.navigate', { url: `${base}/test/manager-open-fixture.html?lang=zh-CN` })
  await click('[data-sidebar-mode="manager"]')
  await run(() => window.__managerOpen.open({ deviceId: 'local', sessionId: 'manager-k1' }))
  const row = '[data-session="manager-k1"] .ss-row.sel'
  await until(() => has(row), '选中当前工作线')
  for (const skin of ['standard', 'human', 'retro']) {
    for (const theme of ['light', 'dark']) {
      await run((look) => window.__litchLook.set(look), { skin, theme })
      await read('document.fonts.ready')
      for (const [status, background, mark] of [
        ['running', null, 'run'],
        ['waiting', null, 'wait'],
        ['idle', { running: 1 }, 'bg'],
      ]) {
        await run(
          (status, background) => {
            const { store, keys } = window.__managerOpen
            const key = keys.summary('local', 'manager-k1')
            store.set(key, { ...store.get(key), status, background, unread: false })
          },
          status,
          background,
        )
        await until(() => has(`${row} .st.${mark}`), `${skin}/${theme}/${mark}`)
        const painted = await run((selector) => {
          const element = document.querySelector(selector)
          // 取动画周期内可见的一帧，复古皮肤的运行光标本来会闪烁。
          for (const animation of element.getAnimations({ subtree: true })) {
            animation.pause()
            animation.currentTime = 0
          }
          const style = getComputedStyle(element, '::before')
          const rect = element.getBoundingClientRect()
          return {
            width: rect.width,
            height: rect.height,
            display: style.display,
            visibility: style.visibility,
            opacity: Number(style.opacity),
            border: parseFloat(style.borderTopWidth),
            color: style.backgroundColor,
            shadow: style.boxShadow,
            ink: style.color,
            content: style.content,
            row: getComputedStyle(element.closest('.ss-row')).backgroundColor,
          }
        }, `${row} .st.${mark}`)
        assert.ok(painted.width > 0 && painted.height > 0)
        assert.notEqual(painted.display, 'none')
        assert.notEqual(painted.visibility, 'hidden')
        assert.ok(painted.opacity > 0)
        assert.ok(
          painted.border > 0 ||
            painted.shadow !== 'none' ||
            painted.content !== '""' ||
            (painted.color !== 'rgba(0, 0, 0, 0)' && painted.color !== painted.row),
          JSON.stringify({ skin, theme, mark, ...painted }),
        )
      }
    }
  }
  console.log(
    '当前选中的经理工作线：三种皮肤 × 明暗 × 运行/等待/后台任务，状态标识均可见；清未读不隐藏标识。',
  )
} finally {
  cdp?.ws.close()
  browser.kill()
  await exited
  rmSync(work, { recursive: true, force: true })
}
