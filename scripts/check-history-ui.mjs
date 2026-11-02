// 分页后的真实浏览器验收：首批范围、顶部补页锚点、搜索未加载历史。只起自己的无头窗口，不保存证据文件。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { Cdp, until } from './chrome-m0/cdp.mjs'

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
const work = mkdtempSync(join(tmpdir(), 'litch-history-ui-'))
const vite = await createServer({
  root: resolve('packages/ui'),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
})
await vite.listen()
const base = vite.resolvedUrls.local[0]
const child = spawn(
  binary,
  [
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-background-networking',
    '--window-size=1200,900',
    'about:blank',
  ],
  {
    env: { PATH: process.env.PATH, HOME: work, CODEX_HOME: join(work, 'codex'), TMPDIR: work },
    stdio: 'ignore',
  },
)
let cdp
const errors = []
try {
  const port = await until(
    () => Number(readFileSync(join(work, 'profile/DevToolsActivePort'), 'utf8').split('\n')[0]),
    '调试端口',
  )
  const endpoint = await until(
    async () =>
      (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (tab) => tab.type === 'page',
      )?.webSocketDebuggerUrl,
    '自己的页面',
  )
  cdp = await Cdp.connect(endpoint)
  await cdp.call('Runtime.enable')
  await cdp.call('Page.enable')
  cdp.listeners.add((event) => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text)
  })
  const evaluate = async (expression) => {
    const result = await cdp.call('Runtime.evaluate', {
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
  await cdp.call('Page.navigate', { url: `${base}test/search-fixture.html?lang=zh-CN&paging=1` })
  await until(
    () => evaluate('document.querySelectorAll("section.turn").length === 10'),
    '首屏十回合',
  )
  assert.equal(await evaluate('window.searchFixture.historyState().pageCalls'), 0)
  const anchor = await evaluate(`(() => {
    const s=document.querySelector('.tr-scroll'); s.scrollTop=-(s.scrollHeight-s.clientHeight-150);
    const box=s.getBoundingClientRect(); const el=[...s.querySelectorAll('[data-anchor]')].find(e=>e.checkVisibility({contentVisibilityAuto:true})&&e.getBoundingClientRect().bottom>box.top);
    return {id:el.getAttribute('data-anchor'),top:el.getBoundingClientRect().top};
  })()`)
  await until(
    () =>
      evaluate(
        'window.searchFixture.historyState().turns >= 20 && document.querySelectorAll("section.turn").length === window.searchFixture.historyState().turns',
      ),
    '向上补十回合',
  )
  await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  const after = await evaluate(
    `document.querySelector('[data-anchor=${JSON.stringify(anchor.id)}]').getBoundingClientRect().top`,
  )
  assert.ok(Math.abs(after - anchor.top) < 3, `翻页锚点偏移 ${after - anchor.top}px`)
  const beforeSearch = await evaluate('window.searchFixture.historyState()')
  await evaluate(`document.querySelector('.search-entry').click()`)
  await until(() => evaluate(`!!document.querySelector('.search-bar input')`), '搜索框')
  // 空查询仍有未读历史：查找条和手动补页入口不能同时占据右上角。
  const searchLayout = []
  for (const width of [420, 1200]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    const layout = await evaluate(`(() => {
      const bar=document.querySelector('.search-float');
      const section=document.querySelector('.search-bar');
      const content=document.querySelector('.tr');
      const rect=bar.getBoundingClientRect();
      return {historyHidden:!document.querySelector('.history-more'),
        sectionHeight:section.getBoundingClientRect().height,
        room:parseFloat(getComputedStyle(content).paddingTop),
        needed:bar.offsetTop+bar.offsetHeight+8,
        left:rect.left,right:rect.right,width:innerWidth};
    })()`)
    assert.ok(layout.historyHidden, '查找期间隐藏手动补页入口')
    assert.equal(layout.sectionHeight, 0, '查找条不占整行')
    assert.ok(layout.room >= layout.needed, '顶部按查找条实际高度让位')
    assert.ok(layout.left >= 0 && layout.right <= layout.width, '窄窗口查找条不溢出')
    searchLayout.push(layout)
  }
  await evaluate(`document.querySelector('.search-bar button:last-of-type').click()`)
  await until(
    () => evaluate(`!!document.querySelector('.history-more')`),
    '关闭空查询后恢复补页入口',
  )
  await evaluate(`document.querySelector('.search-entry').click()`)
  await until(() => evaluate(`!!document.querySelector('.search-bar input')`), '重新打开搜索框')
  await evaluate(`(() => { const input=document.querySelector('.search-bar input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'最早中文');
    input.dispatchEvent(new Event('input',{bubbles:true})); })()`)
  await until(
    () =>
      evaluate(
        `!window.searchFixture.historyState().history.hasMore && CSS.highlights.get('litch-find-current')?.size === 1`,
      ),
    '搜索补齐未加载的历史并定位',
  )
  const found = await evaluate(
    `(() => {const range=[...CSS.highlights.get('litch-find-current')][0];const s=document.querySelector('.tr-scroll').getBoundingClientRect();const r=range.getBoundingClientRect();return {text:range.toString(),item:range.startContainer.parentElement.closest('[data-search-item]').dataset.searchItem,visible:r.bottom>s.top&&r.top<s.bottom,state:window.searchFixture.historyState()}})()`,
  )
  assert.equal(found.text, '最早中文')
  assert.equal(found.item, 't0:u0')
  assert.ok(found.visible)
  await evaluate(`document.querySelector('.search-bar button:last-of-type').click()`)
  await until(() => evaluate(`!document.querySelector('.search-bar')`), '退出搜索')
  await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  const beforeReopen = await evaluate(
    `document.querySelector('[data-search-item="t0:u0"]').getBoundingClientRect().top`,
  )
  await evaluate('window.searchFixture.reopen()')
  await until(
    () =>
      evaluate(
        `window.searchFixture.historyState().turns === 100 && !!document.querySelector('[data-search-item="t0:u0"]')`,
      ),
    '重开时补齐远处锚点',
  )
  await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  const reopened = await evaluate(
    `document.querySelector('[data-search-item="t0:u0"]').getBoundingClientRect().top`,
  )
  assert.ok(Math.abs(reopened - beforeReopen) < 3, `重开后锚点偏移 ${reopened - beforeReopen}px`)
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify({
      firstPage: 10,
      searchLayout,
      anchorShift: after - anchor.top,
      reopenShift: reopened - beforeReopen,
      beforeSearch,
      found,
    }),
  )
} catch (error) {
  console.error(
    'HISTORY_UI_FAILURE',
    errors,
    await cdp?.call('Runtime.evaluate', {
      expression: `JSON.stringify({url:location.href,turns:document.querySelectorAll('section.turn').length,state:window.searchFixture?.historyState(),body:document.body.textContent.slice(0,500)})`,
      returnByValue: true,
    }),
  )
  throw error
} finally {
  cdp?.close()
  child.kill('SIGTERM')
  if (child.exitCode === null)
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ])
  if (child.exitCode === null) child.kill('SIGKILL')
  await vite.close()
  rmSync(work, { recursive: true, force: true })
}
