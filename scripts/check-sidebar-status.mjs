// 正式侧栏的选中及未选中工作线状态回归，隔离无头浏览器；先启动指定工作树的 Vite。
// node scripts/check-sidebar-status.mjs http://127.0.0.1:5199
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
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
  withChromiumTestArgs([
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--window-size=1280,900',
    'about:blank',
  ]),
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
  const row = '[data-session="manager-k1"] .ss-row'
  await until(() => has(`${row}.sel`), '选中当前工作线')
  for (const selected of [true, false]) {
    if (!selected)
      await run(() => window.__managerOpen.open({ deviceId: 'local', sessionId: 'manager-k2' }))
    await until(() => has(`${row}${selected ? '.sel' : ':not(.sel)'}`), '工作线选中状态')
    await until(
      () =>
        run(
          (sessionId) => {
            const { store, keys } = window.__managerOpen
            return !!store.get(keys.session('local', sessionId))
          },
          selected ? 'manager-k1' : 'manager-k2',
        ),
      '当前会话快照',
    )
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
          await until(() => has(`${row} .st.${mark}`), `${selected}/${skin}/${theme}/${mark}`)
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
  }
  // 从经理建议页真实点击开始；只订阅父会话，子会话一次都不打开。
  await run(() => window.__managerOpen.open({ deviceId: 'local', sessionId: 'm1' }))
  await until(() => has('[data-manager="session"][data-manager-id="m1"]'), '经理来源会话')
  if (await has('[data-act="manager-board-toggle"][aria-expanded="true"]'))
    await click('[data-act="manager-board-toggle"]')
  await until(() => has('.main .dock textarea.cmp-text'), '经理输入框')
  await run(() => {
    const input = document.querySelector('.main .dock textarea.cmp-text')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
      input,
      '提个子会话',
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await until(
    () =>
      run(() => document.querySelector('.main .dock textarea.cmp-text')?.value === '提个子会话'),
    '输入进入草稿',
  )
  await run(() =>
    document
      .querySelector('.main .dock textarea.cmp-text')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  )
  await until(() => has('.main [data-card="proposal"]'), '经理生成建议')
  await click('[data-act="manager-board-toggle"]')
  if (!(await has('[data-board-tab="suggestions"]'))) await click('[data-board-tab="inbox"]')
  await click('[data-board-tab="suggestions"]')
  const manager = '.mg-sidebar-manager[data-manager-id="m1"]'
  if (await has(`${manager} .row-line > .tree-fold[aria-expanded="false"]`))
    await click(`${manager} .row-line > .tree-fold[aria-expanded="false"]`)
  const before = await run(() => {
    const { store, keys } = window.__managerOpen
    return store.get(keys.children('local'))?.m1 ?? []
  })
  // Pi 示例刻意超出父会话权限；选择同 harness 的 CHANGELOG 卡，验真实可启动路径。
  const proposal = await until(
    () =>
      run(() => {
        const title = [...document.querySelectorAll('.suggestion-row .prop-title')].find(
          (node) => node.textContent === '整理 CHANGELOG',
        )
        return title?.closest('[data-proposal]')?.getAttribute('data-proposal')
      }),
    '可开始的 CHANGELOG 建议',
  )
  await click(`.suggestion-row [data-proposal="${proposal}"] [data-act="start"]`)
  const child = await until(
    () =>
      run((old) => {
        const { store, keys } = window.__managerOpen
        return (store.get(keys.children('local'))?.m1 ?? []).find((id) => !old.includes(id))
      }, before),
    '新建议工作线',
  )
  const unopenedRow = `${manager} [data-session="${child}"] .ss-row`
  const unopened = () =>
    run((id) => {
      const { store, keys } = window.__managerOpen
      return (
        !store.get(keys.session('local', id)) &&
        document.querySelector('[data-composer-session]')?.getAttribute('data-composer-session') ===
          '["local","m1"]'
      )
    }, child)
  await until(() => has(`${unopenedRow} .st.run`), '从未打开的工作线出现运行标识')
  assert.equal(await unopened(), true)
  await until(async () => {
    assert.equal(await unopened(), true, '验收期间不能打开子会话补齐状态')
    return run(
      (id, selector) => {
        const { store, keys } = window.__managerOpen
        return (
          store.get(keys.summary('local', id))?.status === 'idle' &&
          !!document.querySelector(selector) &&
          !document.querySelector(`${selector} .st.run`)
        )
      },
      child,
      unopenedRow,
    )
  }, '从未打开的工作线完成后移除运行标识')
  assert.equal(await unopened(), true)
  console.log('经理建议页点击开始：从未打开子会话，正式侧栏仍呈现运行→空闲，父会话选择保持不变。')
  console.log(
    '经理工作线：选中/未选中 × 三种皮肤 × 明暗 × 运行/等待/后台任务，状态标识均可见；清未读不隐藏标识。',
  )
} finally {
  cdp?.ws.close()
  browser.kill()
  await exited
  rmSync(work, { recursive: true, force: true })
}
