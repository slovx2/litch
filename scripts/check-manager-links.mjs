// 完整经理页面、模拟核心、无头浏览器；不接触真实设备或登录目录。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { globSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'
import { installManagerBoardMobileFixture } from './manager-board-mobile-fixture.mjs'

const repo = resolve(import.meta.dirname, '..')
const root = mkdtempSync(join(tmpdir(), 'manager-links-'))
const mobile = process.argv.includes('--mobile')
const mobileUi = mobile ? await installManagerBoardMobileFixture({ links: true }) : null
const server = mobile
  ? null
  : spawn(
      process.execPath,
      ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5298', '--strictPort'],
      { cwd: join(repo, 'packages/ui'), stdio: 'ignore' },
    )
let browser, cdp, inspect
try {
  await until(async () => {
    try {
      return (await fetch(mobileUi?.url ?? 'http://127.0.0.1:5298')).ok
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
    withChromiumTestArgs([
      '--headless=new',
      `--user-data-dir=${root}/profile`,
      '--remote-debugging-port=0',
      '--no-first-run',
      'about:blank',
    ]),
    {
      env: { HOME: root, PATH: '/usr/bin:/bin', TMPDIR: root },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let output = ''
  browser.stderr.on('data', (chunk) => {
    output += chunk
  })
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
  inspect = () =>
    read('({text:document.body.innerText.slice(0, 4000),calls:window.__managerLinks?.calls})')
  await call('Runtime.enable')
  cdp.listeners.add((frame) => {
    if (frame.method === 'Runtime.exceptionThrown') console.error(JSON.stringify(frame.params))
  })
  const wait = (s) =>
    until(() => read(`!!document.querySelector(${JSON.stringify(s)})`), s, mobile ? 60000 : 15000)
  const click = async (s) => {
    await wait(s)
    await read(`document.querySelector(${JSON.stringify(s)}).click()`)
  }
  await call('Emulation.setDeviceMetricsOverride', {
    width: mobile ? 412 : 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await call('Page.navigate', {
    url: mobileUi
      ? `${mobileUi.url}/?app=1&scene=manager-console&lang=zh-CN&skin=standard`
      : 'http://127.0.0.1:5298/test/manager-link-fixture.html?onboarding=off&lang=zh-CN',
  })
  if (mobile) {
    await wait('[data-testid="paging-object:D-1"]')
    const located = async (id, status) => {
      await until(
        () =>
          read(
            `(()=>{const e=document.querySelector('[data-testid="paging-filter:${status}"]');return e && getComputedStyle(e).borderBottomWidth === '2px'})()`,
          ),
        `手机筛选 ${status}`,
      )
      await wait(`[data-testid="paging-detail:${id}"]`)
      await until(
        () =>
          read(
            `(()=>{const card=document.querySelector('[data-testid="paging-detail:${id}"]');const host=document.querySelector('[data-testid="manager-board-scroll"]');if(!card||!host)return false;const a=card.getBoundingClientRect(),b=host.getBoundingClientRect();return a.bottom>b.top&&a.top<b.bottom&&parseFloat(getComputedStyle(card).borderTopWidth)===2})()`,
          ),
        '手机定位卡片可见且高亮',
      )
    }
    for (const [id, states] of [
      ['D-15', ['open', 'answered', 'expired', 'withdrawn', 'ignored']],
      ['I-1', ['backlog', 'running', 'review', 'blocked', 'done', 'deferred']],
      ['R-1', ['open', 'replied', 'delivered', 'cancelled']],
      ['P-1', ['unread', 'read']],
    ]) {
      for (const state of states) {
        await read(
          `window.__managerLinks.change(${JSON.stringify(id)},${JSON.stringify(state)});window.__managerLinks.jump(${JSON.stringify(id)})`,
        )
        await located(id, ['expired', 'withdrawn'].includes(state) ? 'closed' : state)
      }
    }
    await read(
      "window.__managerLinks.delay();window.__managerLinks.change('D-15','answered');window.__managerLinks.jump('D-15')",
    )
    await located('D-15', 'answered')
    for (const state of ['expired', 'open', 'answered']) {
      await read(`window.__managerLinks.change('D-15',${JSON.stringify(state)})`)
      await located('D-15', state === 'expired' ? 'closed' : state)
    }
    await click('[data-testid="paging-filter:open"]')
    await read("window.__managerLinks.change('D-15','ignored')")
    assert.equal(
      await read(
        'getComputedStyle(document.querySelector(\'[data-testid="paging-filter:open"]\')).borderBottomWidth',
      ),
      '2px',
    )
    await read("window.__managerLinks.jump('D-15')")
    await located('D-15', 'ignored')
    console.log('手机编号定位：全部决策/事项/请求/报告状态、延迟详情、后续更新及手动筛选通过')
  } else {
    await click('[data-sidebar-mode="manager"]')
    await click('[data-manager-id="m1"] .mg-pick')
    await wait('.mg-chat [data-board-reference]')
    const selectedFilter =
      "document.querySelector('[data-paging-filter][aria-pressed=true]')?.dataset.pagingFilter"
    const located = async (id, status) => {
      await until(
        () => read(`${selectedFilter} === ${JSON.stringify(status)}`),
        `${id} → ${status}`,
      )
      await wait(`[data-paging-detail="${id}"][data-linked]`)
      await until(
        () => read(`document.activeElement?.dataset.pagingDetail === ${JSON.stringify(id)}`),
        '定位焦点',
      )
      assert.ok(
        await read(
          `(()=>{const card=document.querySelector('[data-paging-detail="${id}"]').getBoundingClientRect();const host=document.querySelector('.mg-body').getBoundingClientRect();return card.bottom>host.top && card.top<host.bottom})()`,
        ),
        '定位卡片进入视口',
      )
    }
    const jump = (id) =>
      read(
        `window.dispatchEvent(new CustomEvent('litch-manager-issue',{detail:{managerId:'m1',id:${JSON.stringify(id)}}}))`,
      )
    await click('.mg-chat [data-board-reference="D-15"]')
    await wait('[data-paging-detail="D-15"]')
    console.log(
      JSON.stringify({
        linked: 'D-15',
        actualStatus: 'answered',
        filter: await read(selectedFilter),
      }),
    )
    await located('D-15', 'answered')
    for (const [id, states] of [
      ['D-15', ['open', 'answered', 'expired', 'withdrawn', 'ignored']],
      ['I-1', ['backlog', 'running', 'review', 'blocked', 'done', 'deferred']],
      ['R-1', ['open', 'replied', 'delivered', 'cancelled']],
      ['P-1', ['unread', 'read']],
    ]) {
      for (const state of states) {
        await read(`window.__managerLinks.change(${JSON.stringify(id)},${JSON.stringify(state)})`)
        await jump(id)
        await located(id, ['expired', 'withdrawn'].includes(state) ? 'closed' : state)
      }
    }
    // 同一次链接在详情延迟、后续答复和重开时随当前状态移动。
    await read("window.__managerLinks.delay();window.__managerLinks.change('D-15','answered')")
    await jump('D-15')
    await located('D-15', 'answered')
    for (const state of ['expired', 'open', 'answered']) {
      await read(`window.__managerLinks.change('D-15',${JSON.stringify(state)})`)
      await located('D-15', state === 'expired' ? 'closed' : state)
    }
    await click('[data-paging-filter="open"]')
    await read("window.__managerLinks.change('D-15','ignored')")
    assert.equal(await read(selectedFilter), 'open', '手动切筛选后不再被旧链接拉走')
    console.log('经理聊天编号、五种决策状态、事项/请求/报告、延迟详情与后续状态变化通过')
  }
} catch (error) {
  console.error(await inspect?.())
  throw error
} finally {
  cdp?.close()
  if (browser && browser.exitCode === null) {
    const exited = once(browser, 'exit')
    browser.kill()
    await exited
  }
  server?.kill()
  await mobileUi?.close()
  // 本脚本自己创建的临时目录，路径只来自 mkdtemp。
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
}
