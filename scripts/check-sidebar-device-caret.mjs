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
        assert.deepEqual(seen.indent, [18, 36], '子孙缩进保持一致')
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
  await treeColumns()
  await pinnedPaging()
  console.log('SIDEBAR_DEVICE_CARET_PASS')

  /** 置顶的项目和设备树的项目一样分页：前 5 个、显示更多、收起；外部定位到收着的那部分会露出来 */
  async function pinnedPaging() {
    const pins = '[data-shortcuts=pins]'
    const head = `${pins} [data-workspace=docs] .ws-row`
    await click('.dev-group[data-device=local] [data-workspace=docs] .row-more button')
    await click('.pick-pop [data-action=pin]')
    await until(() => has(head), '置顶项目')
    if (
      (await run((s) => document.querySelector(s).getAttribute('aria-expanded'), head)) !== 'true'
    )
      await click(head)
    const area = `${pins} .sc-ws[data-device=local]`
    const seen = () =>
      run(
        (s) => ({
          rows: document.querySelectorAll(`${s} .tree-node[data-depth="0"]`).length,
          hidden: document.querySelector(`${s} .ss-more .dim`)?.textContent ?? null,
          less: !!document.querySelector(`${s} .ss-more .less`),
        }),
        area,
      )
    await until(async () => (await seen()).rows > 0, '展开置顶项目')
    const first = await seen()
    assert.equal(first.rows, 5, '置顶项目先露出 5 个')
    assert.match(first.hidden ?? '', /7/, '写出还收着几个')
    await click(`${area} .ss-more .more`)
    await until(async () => (await seen()).rows === 12, '显示更多')
    assert.equal((await seen()).less, true, '显示更多之后能收起')
    await click(`${area} .ss-more .less`)
    await until(async () => (await seen()).rows === 5, '收起')
    // 从搜索、通知打开收着的最后一个：分页让开
    await read("window.__sidebarTree.open({ deviceId: 'local', sessionId: 'd9' })")
    await until(() => has(`${area} [data-session="d9"]`), '定位露出分页里收着的会话')
    console.log('置顶项目分页：前 5 个、显示更多、收起、外部定位露出')
  }

  /** 箭头与记号共用一列：设备树里箭头在项目缩进之内，聚合区不留空列、选中行不画分接线、“N 个子会话”对齐 */
  async function treeColumns() {
    await call('Page.navigate', { url: `${base}/test/sidebar-tree-fixture.html?lang=zh-CN` })
    await until(
      () => has('[data-projection=recent] [data-session="s4"] > .tree-fold'),
      '夹具子会话',
    )
    await read('window.__sidebarTree.seeded.then(() => true)')
    if (await has('[data-act=onboard-later]')) await click('[data-act=onboard-later]')
    const recent = '[data-projection=recent]'
    await click(`${recent} [data-session="s4"] > .tree-fold`)
    await until(() => has(`${recent} [data-parent="s4"]`), '最近区展开子树')
    await click(`${recent} [data-session="s1"] > .ss-row`)
    for (const skin of ['standard', 'human', 'retro'])
      for (const theme of ['light', 'dark']) {
        await read(`(async()=>{
      window.__litchLook.set(${JSON.stringify({ skin, theme })})
      await document.fonts.ready
      await new Promise(resolve => requestAnimationFrame(()=>requestAnimationFrame(resolve)))
    })()`)
        const seen = await run(() => {
          const box = (e) => e.getBoundingClientRect()
          const mid = (e) => box(e).left + box(e).width / 2
          const folds = [...document.querySelectorAll('.row-line:has(> .tree-fold)')].map((e) => ({
            id: e.dataset.session,
            offset: mid(e.querySelector(':scope > .tree-fold')) - mid(e.querySelector('.st')),
          }))
          const local = '.dev-group[data-device="local"]'
          const project = Math.max(
            ...[...document.querySelectorAll(`${local} .ws-row .caret-ic`)].map(
              (e) => box(e).right,
            ),
          )
          // 会话箭头图标的中心在项目箭头图标的右边
          const deviceFolds = [
            ...document.querySelectorAll(`${local} .row-line > .tree-fold .caret-ic`),
          ].map(mid)
          const tops = [
            ...document.querySelectorAll(
              '[data-projection] .tree-node[data-depth="0"] > .row-line > .ss-row, [data-shortcuts] .tree-node[data-depth="0"] > .row-line > .ss-row',
            ),
          ].map((row) => ({
            tick: box(row.querySelector('.dev-tick')).left,
            tickEnd: box(row.querySelector('.dev-tick')).right,
            st: box(row.querySelector('.st')).left,
            title: box(row.querySelector('.title')).left,
            // 经理框（::after）居中画在记号列里：量出框的左右边
            frame: row.querySelector('.st.mgr')
              ? (() => {
                  const st = box(row.querySelector('.st'))
                  const width = parseFloat(
                    getComputedStyle(row.querySelector('.st'), '::after').width,
                  )
                  return {
                    left: st.left + (st.width - width) / 2,
                    right: st.right - (st.width - width) / 2,
                  }
                })()
              : null,
          }))
          const parent = document.querySelector('[data-projection=recent] [data-session="s4"]')
          const kid = parent
            .closest('.tree-node')
            .querySelector('.tree-kids .tree-node:has(> .tree-kids > .tree-sum)')
          const sum = kid.querySelector(':scope > .tree-kids > .tree-sum')
          const kidRow = kid.querySelector(':scope > .row-line > .ss-row')
          const parentRow = parent.closest('.row-line').querySelector(':scope > .ss-row')
          // 设备树项目下的顶层会话：标题同列；子会话记号落在父标题那一列
          const deviceTops = [
            ...document.querySelectorAll(
              `${local} .tree-node[data-depth="0"] > .row-line > .ss-row`,
            ),
          ].map((row) => box(row.querySelector('.title')).left)
          const deviceParent = document.querySelector(`${local} [data-session="s4"] > .ss-row`)
          const deviceKid = deviceParent
            .closest('.tree-node')
            .querySelector('.tree-kids .tree-node > .row-line > .ss-row')
          const selected = (area) =>
            getComputedStyle(document.querySelector(`${area} .ss-row.sel`), '::before').content
          return {
            folds,
            project,
            deviceFolds,
            tops,
            sum: sum && {
              caret: mid(sum.querySelector('.caret-ic')) - (mid(kidRow.querySelector('.st')) + 18),
              text:
                box(sum.querySelector('.ell')).left -
                (box(kidRow.querySelector('.title')).left + 18),
            },
            recentSel: selected('[data-projection=recent]'),
            deviceTops,
            kidUnderTitle: [
              [parentRow, kidRow],
              [deviceParent, deviceKid],
            ].map(
              ([up, down]) =>
                box(down.querySelector('.st')).left - box(up.querySelector('.title')).left,
            ),
            gap: box(kidRow.querySelector('.title')).left - box(kidRow.querySelector('.st')).right,
          }
        })
        const tag = `${skin}/${theme}`
        assert.ok(seen.folds.length >= 4, `${tag} 覆盖带子会话的行`)
        for (const fold of seen.folds)
          assert.ok(Math.abs(fold.offset) <= 1, `${tag} 箭头和记号同一列：${JSON.stringify(fold)}`)
        assert.ok(seen.deviceFolds.length >= 2, `${tag} 设备树项目里有带箭头的会话`)
        for (const left of seen.deviceFolds)
          assert.ok(
            left >= seen.project,
            `${tag} 设备树箭头在项目缩进之内：${left} < ${seen.project}`,
          )
        const title = seen.tops[0].title
        for (const top of seen.tops) {
          assert.ok(Math.abs(top.title - title) < 1, `${tag} 聚合区标题同列`)
          assert.ok(top.tickEnd <= top.st, `${tag} 色条不压记号：${JSON.stringify(top)}`)
          assert.ok(top.title - top.tick <= 23, `${tag} 色条到标题不留空列：${JSON.stringify(top)}`)
        }
        const framed = seen.tops.filter((top) => top.frame)
        assert.ok(framed.length >= 1, `${tag} 覆盖带框记号的行`)
        for (const top of framed) {
          assert.ok(
            top.frame.left - top.tickEnd >= 2.5,
            `${tag} 框和色条留空：${JSON.stringify(top)}`,
          )
          assert.ok(
            top.title - top.frame.right >= 2.5,
            `${tag} 框和标题留空：${JSON.stringify(top)}`,
          )
        }
        assert.ok(seen.sum, `${tag} 有收起的子会话行`)
        assert.ok(Math.abs(seen.sum.caret) <= 1, `${tag} “N 个子会话”箭头在记号列`)
        assert.ok(Math.abs(seen.sum.text) <= 1, `${tag} “N 个子会话”文字在标题列`)
        assert.equal(seen.recentSel, 'none', `${tag} 聚合区选中行不画分接线`)
        assert.ok(
          seen.deviceTops.every((x) => Math.abs(x - seen.deviceTops[0]) < 1),
          `${tag} 设备树顶层会话标题同列`,
        )
        for (const offset of seen.kidUnderTitle)
          assert.ok(Math.abs(offset) <= 1, `${tag} 子会话记号在父标题列：${offset}`)
        assert.ok(Math.abs(seen.gap - 4) <= 0.5, `${tag} 记号到标题 4px：${seen.gap}`)
      }
    // 有记号的父会话：平时露记号，鼠标停上去换成箭头
    const marked = `${recent} [data-session="s1"]`
    const state = () =>
      run((s) => {
        const line = document.querySelector(s)
        return {
          fold: getComputedStyle(line.querySelector(':scope > .tree-fold')).opacity,
          st: getComputedStyle(line.querySelector('.st')).visibility,
        }
      }, marked)
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1200, y: 800 })
    assert.deepEqual(await state(), { fold: '0', st: 'visible' }, '平时露记号')
    const point = await run((s) => {
      const r = document.querySelector(`${s} .title`).getBoundingClientRect()
      return { x: r.left + 10, y: r.top + r.height / 2 }
    }, marked)
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await until(async () => (await state()).fold === '1', '悬停换出箭头')
    assert.equal((await state()).st, 'hidden', '悬停时记号让位')
    console.log('箭头与记号同列、设备树箭头在项目缩进内、聚合区无空列与分接线、子会话汇总行对齐')
  }
} finally {
  cdp?.ws.close()
  browser.kill()
  await exited
  await vite.close()
  rmSync(work, { recursive: true, force: true })
}
