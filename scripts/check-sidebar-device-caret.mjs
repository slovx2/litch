// 侧栏设备色条与树箭头的布局回归，自动启动正式 App、模拟核心和隔离无头 Chrome。
// node scripts/check-sidebar-device-caret.mjs；LITCH_CARET_SHOTS=1 临时输出截图，查看后删除。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const vite = await createServer({
  root: new URL('../packages/ui', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 0, hmr: false },
  logLevel: 'error',
})
await vite.listen()
const base = vite.resolvedUrls.local[0].replace(/\/$/, '')
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
const work = mkdtempSync(join(tmpdir(), 'litch-sidebar-caret-'))
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
  await until(() => has('.ss-row'), '侧栏会话')
  if (await has('[data-act=onboard-later]')) await click('[data-act=onboard-later]')
  await run(() => {
    const { store, keys } = window.__managerOpen
    store.set(keys.groups('local'), {
      ...store.get(keys.groups('local')),
      ':pinned': ['s1', 's3', 'm1'],
    })
    store.set(keys.children('local'), {
      ...store.get(keys.children('local')),
      s1: ['s2'],
      s2: ['s4'],
      s7: ['s6'],
    })
    store.set(keys.organizer, {
      status: 'ok',
      revision: 1,
      pinOrder: [],
      folds: {},
      groups: [
        {
          id: 'layout',
          name: '本机分组',
          members: [
            { deviceId: 'local', sessionId: 's7' },
            { deviceId: 'local', sessionId: 's8' },
          ],
        },
      ],
    })
  })
  const pin = '[data-shortcuts="pins"]'
  await click(`${pin} [data-session="s1"] > .tree-fold`)
  await click(`${pin} [data-session="s2"] > .tree-fold`)
  await until(() => has('[data-local-group="layout"] [data-session="s7"]'), '本机分组')
  await click('[data-local-group="layout"] [data-session="s7"] > .tree-fold')
  for (const skin of ['standard', 'human', 'retro'])
    for (const theme of ['light', 'dark'])
      for (const width of [240, 480]) {
        await read(`(async()=>{
      const {setSidebarWidth}=await import('/src/sidebar/state.ts')
      setSidebarWidth(${width})
      window.__litchLook.set(${JSON.stringify({ skin, theme })})
      await document.fonts.ready
      await new Promise(resolve => requestAnimationFrame(()=>requestAnimationFrame(resolve)))
    })()`)
        const seen = await run(() => {
          const rect = (e) => {
            const r = e.getBoundingClientRect()
            return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height }
          }
          const row = (area, id) =>
            document.querySelector(`${area} [data-session="${id}"] > .ss-row`)
          const pin = '[data-shortcuts="pins"]',
            group = '[data-local-group="layout"]'
          const columns = [row(pin, 's1'), row(pin, 's3'), row(group, 's7'), row(group, 's8')].map(
            (e) => rect(e.querySelector('.title')).left - rect(e).left,
          )
          const parent = row(pin, 's1'),
            child = row(pin, 's2'),
            grand = row(pin, 's4')
          const kids = parent.closest('.tree-node').querySelector(':scope > .tree-kids')
          const point = rect(parent.querySelector('.st'))
          return {
            columns,
            indent: [child, grand].map(
              (e) =>
                rect(e.querySelector('.title')).left - rect(parent.querySelector('.title')).left,
            ),
            guide: rect(kids).left + parseFloat(getComputedStyle(kids, '::before').left),
            point: point.left + point.width / 2,
            rows: [
              ...document.querySelectorAll(
                '.sc-body .row-line:has(> .tree-fold):has(> .ss-row > .dev-tick)',
              ),
            ].map((e) => {
              const tick = rect(e.querySelector('.dev-tick')),
                fold = rect(e.querySelector('.tree-fold'))
              const hit = document.elementFromPoint(
                fold.left + fold.width / 2,
                fold.top + fold.height / 2,
              )
              return { id: e.dataset.session, tick, fold, hit: !!hit?.closest('.tree-fold') }
            }),
          }
        })
        assert.ok(seen.rows.length >= 3, '覆盖置顶普通父会话、经理及本机分组')
        for (const row of seen.rows) {
          assert.ok(
            row.tick.right <= row.fold.left,
            `${skin}/${theme}/${width} 色条覆盖箭头：${JSON.stringify(row)}`,
          )
          assert.ok(row.tick.left >= 0, '色条仍在窗口内')
          assert.ok(row.fold.width >= 12 && row.fold.height >= 18 && row.hit, '箭头热区完整可点击')
        }
        assert.ok(
          seen.columns.every((x) => Math.abs(x - seen.columns[0]) < 1),
          '带箭头与不带箭头的标题同列',
        )
        assert.deepEqual(seen.indent, [20, 40], '子孙缩进保持一致')
        assert.ok(Math.abs(seen.guide - seen.point) <= 1, '父状态点与子树竖线对齐')
        if (process.env.LITCH_CARET_SHOTS) {
          const shot = await call('Page.captureScreenshot', {
            format: 'png',
            clip: { x: 0, y: 0, width, height: 720, scale: 1 },
          })
          writeFileSync(
            `/tmp/litch-caret-${skin}-${theme}-${width}.png`,
            Buffer.from(shot.data, 'base64'),
          )
        }
        console.log(`${skin}/${theme}/${width}: 色条和箭头分离，标题与缩进对齐，热区完整`)
      }
  await click(`${pin} [data-session="s1"] > .tree-fold`)
  assert.equal(await has(`${pin} [data-session="s2"]`), false, '箭头仍可收起子树')
  await click(`${pin} [data-session="s1"] > .tree-fold`)
  await until(() => has(`${pin} [data-session="s2"]`), '箭头仍可展开子树')
  console.log('SIDEBAR_DEVICE_CARET_PASS')
} finally {
  cdp?.ws.close()
  browser.kill()
  await exited
  await vite.close()
  rmSync(work, { recursive: true, force: true })
}
