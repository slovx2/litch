// 隔离隐藏窗口验证长会话切换：测事件循环延迟、侧栏响应、滚动恢复和连续切换。
// 先 npm run client:build，再 node apps/desktop/scripts/check-session-open.mjs。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureEnvironment } from '../../../scripts/fixture-environment.mjs'

const require = createRequire(import.meta.url)
if (!process.versions.electron) {
  const { preview } = await import('../../../packages/ui/node_modules/vite/dist/node/index.js')
  const scratch = mkdtempSync(join(tmpdir(), 'litch-session-open-'))
  const server = await preview({
    root: fileURLToPath(new URL('../../../packages/ui', import.meta.url)),
    preview: { host: '127.0.0.1', port: 0 },
  })
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url)], {
    env: {
      ...fixtureEnvironment(),
      HOME: scratch,
      CODEX_HOME: join(scratch, 'codex'),
      LITCH_OPEN_PROFILE: join(scratch, 'profile'),
      LITCH_OPEN_URL: server.resolvedUrls.local[0],
      LITCH_OPEN_RESULT: process.env.LITCH_OPEN_RESULT ?? '',
    },
    stdio: 'inherit',
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000)
  try {
    process.exitCode = await new Promise((resolve) =>
      child.on('exit', (code) => resolve(code ?? 1)),
    )
  } finally {
    clearTimeout(timeout)
    await server.close()
  }
} else {
  const { app, BrowserWindow } = require('electron')
  app.setPath('userData', process.env.LITCH_OPEN_PROFILE)
  void app.whenReady().then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 1400,
      height: 950,
      webPreferences: { sandbox: true, backgroundThrottling: false },
    })
    const run = (fn, ...args) =>
      win.webContents.executeJavaScript(
        `(${fn})(${args.map((arg) => JSON.stringify(arg)).join(',')})`,
      )
    try {
      await win.loadURL(`${process.env.LITCH_OPEN_URL}?lang=zh-CN&onboarding=off`)
      await run(install)
      const results = []
      for (const batches of [1, 3]) {
        await run(async (batches) => {
          const b = window.openCheck
          await b.open(b.large)
          while (b.batches < batches) {
            await b.say('造长历史')
            b.batches++
            await b.until(() => document.querySelectorAll('section.turn').length >= b.batches * 300)
          }
          await b.sleep(250)
        }, batches)
        for (const where of ['bottom', 'middle', 'top']) {
          const result = await run(measure, where)
          console.log(JSON.stringify({ batches, ...result }))
          assert.ok(result.restoreShift <= 3, `滚动恢复偏移 ${result.restoreShift}px`)
          // 性能数值完整输出；保守上限只拦整段阻塞，不把共享跑机的几十毫秒抖动当成功能错误。
          assert.ok(result.maxTick < 250, `界面连续阻塞 ${result.maxTick}ms`)
          assert.ok(result.selected < 150, `侧栏选中延迟 ${result.selected}ms`)
          results.push({ batches, ...result })
        }
        const switches = await run(rapidSwitch)
        console.log(JSON.stringify({ batches, switches }))
        assert.ok(switches.maxDelay < 250, `连续点击被阻塞 ${switches.maxDelay}ms`)
        assert.ok(switches.foldDelay < 150, `侧栏展开收起延迟 ${switches.foldDelay}ms`)
        assert.equal(switches.finalTitle, '发版前的检查清单')
        results.push({ batches, switches })
      }
      await run(checkLongMessage)
      if (process.env.LITCH_OPEN_RESULT) {
        writeFileSync(process.env.LITCH_OPEN_RESULT, `${JSON.stringify(results, null, 2)}\n`)
        writeFileSync(
          `${process.env.LITCH_OPEN_RESULT}.png`,
          (await win.webContents.capturePage()).toPNG(),
        )
      }
      app.exit(0)
    } catch (error) {
      console.error(error)
      app.exit(1)
    }
  })
}

async function install() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (check) => {
    const end = performance.now() + 20_000
    while (performance.now() < end) {
      if (check()) return
      await sleep(10)
    }
    throw new Error(`等待超时：${check}`)
  }
  const row = (title) =>
    [...document.querySelectorAll('.ss-row')].find((entry) => entry.textContent.includes(title))
  const click = (title) => {
    const entry = row(title)
    if (!entry) throw new Error(`会话不存在：${title}`)
    entry.click()
  }
  const open = async (title) => {
    click(title)
    await until(
      () => row(title)?.classList.contains('sel') && document.querySelector('.dock .cmp-text'),
    )
    await sleep(200)
  }
  const say = async (text) => {
    const input = document.querySelector('.dock .cmp-text')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(30)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await sleep(300)
  }
  window.openCheck = {
    sleep,
    until,
    row,
    click,
    open,
    say,
    batches: 0,
    tasks: [],
    large: '远程设备安装指引',
    small: '发版前的检查清单',
  }
  new PerformanceObserver((list) => {
    window.openCheck.tasks.push(...list.getEntries().map((entry) => entry.duration))
  }).observe({ type: 'longtask' })
  await until(() => document.querySelector('.ss-row'))
}

async function measure(where) {
  const b = window.openCheck
  const scroller = document.querySelector('.tr-scroll')
  const turns = [...document.querySelectorAll('section.turn')]
  if (where === 'bottom') scroller.scrollTop = 0
  else turns[where === 'top' ? 0 : Math.floor(turns.length / 2)].scrollIntoView({ block: 'start' })
  await b.sleep(350)
  const top = scroller.getBoundingClientRect().top
  const visible = [...document.querySelectorAll('.tr [data-anchor]')].find(
    (node) =>
      node.checkVisibility({ contentVisibilityAuto: true }) &&
      node.getBoundingClientRect().bottom > top,
  )
  const anchor = visible?.getAttribute('data-anchor')
  const offset = visible ? visible.getBoundingClientRect().top - top : 0
  await b.open(b.small)
  b.tasks = []
  const ticks = []
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    ticks.push(now - last)
    last = now
  }, 10)
  const start = performance.now()
  b.click(b.large)
  await b.until(() => b.row(b.large)?.classList.contains('sel'))
  const selected = performance.now() - start
  await b.until(() => document.querySelectorAll('section.turn').length >= b.batches * 300)
  await b.until(() => document.querySelector('.tr-scroll')?.getAttribute('aria-busy') !== 'true')
  const ready = performance.now() - start
  await b.sleep(350)
  clearInterval(timer)
  const current = anchor && document.querySelector(`[data-anchor="${CSS.escape(anchor)}"]`)
  const currentTop = document.querySelector('.tr-scroll').getBoundingClientRect().top
  const restoreShift =
    where === 'bottom'
      ? Math.abs(document.querySelector('.tr-scroll').scrollTop)
      : current
        ? Math.abs(current.getBoundingClientRect().top - currentTop - offset)
        : Infinity
  return { where, selected, ready, maxTick: Math.max(...ticks), tasks: b.tasks, restoreShift }
}

async function rapidSwitch() {
  const b = window.openCheck
  await b.open(b.small)
  const delays = []
  b.click(b.large)
  const fold = document.querySelector('.head-toggle[aria-expanded="true"]')
  if (!fold) throw new Error('找不到展开的侧栏分组')
  let foldDelay = 0
  for (const expanded of ['false', 'true']) {
    const start = performance.now()
    fold.click()
    await b.until(() => fold.getAttribute('aria-expanded') === expanded)
    foldDelay = Math.max(foldDelay, performance.now() - start)
  }
  await b.open(b.small)
  for (let index = 0; index < 6; index++) {
    b.click(b.large)
    const due = performance.now() + 20
    await b.sleep(20)
    delays.push(performance.now() - due)
    b.click(b.small)
    await b.until(() => b.row(b.small)?.classList.contains('sel'))
    await b.sleep(30)
  }
  await b.sleep(400)
  return {
    maxDelay: Math.max(...delays),
    foldDelay,
    finalTitle: document.querySelector('.ss-row.sel .title')?.textContent,
  }
}

async function checkLongMessage() {
  const b = window.openCheck
  await b.open(b.small)
  await b.say(
    Array.from({ length: 35 }, (_, index) => `长消息高度检查第 ${index + 1} 行`).join('\n'),
  )
  const bubble = () =>
    [...document.querySelectorAll('.umsg')].find((node) =>
      node.textContent.includes('长消息高度检查'),
    )
  await b.until(() => bubble()?.querySelector(':scope > .mini'))
  const text = bubble().querySelector('.umsg-text')
  const height = text.clientHeight
  bubble().querySelector(':scope > .mini').click()
  await b.until(() => !text.classList.contains('clamp') && text.clientHeight > height)
  bubble().querySelector(':scope > .mini').click()
  await b.until(() => text.classList.contains('clamp') && text.clientHeight === height)
}
