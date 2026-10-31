// 回到底部、轻滚、切会话再切回、再次轻滚：必须用真实滚轮输入，直接改 scrollTop 抓不到合成线程的坐标错位。
// 先构建 UI。隐藏窗口、隔离 HOME、模拟核心；不连接真实设备。可用 LITCH_WHEEL_RESULT 保存测量结果。
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
  const scratch = mkdtempSync(join(tmpdir(), 'litch-scroll-wheel-'))
  const server = await preview({
    root: fileURLToPath(new URL('../../../packages/ui', import.meta.url)),
    preview: { host: '127.0.0.1', port: 0, strictPort: false },
  })
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url)], {
    env: {
      ...fixtureEnvironment(),
      HOME: scratch,
      CODEX_HOME: join(scratch, 'codex'),
      LITCH_WHEEL_PROFILE: join(scratch, 'profile'),
      LITCH_WHEEL_URL: server.resolvedUrls.local[0],
      LITCH_WHEEL_RESULT: process.env.LITCH_WHEEL_RESULT ?? '',
    },
    stdio: 'inherit',
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 150_000)
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
  app.setPath('userData', process.env.LITCH_WHEEL_PROFILE)
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
      await win.loadURL(`${process.env.LITCH_WHEEL_URL}?lang=zh-CN&onboarding=off`)
      await run(install)
      win.webContents.debugger.attach('1.3')
      const wheel = async (deltaY, deltaX = 0) => {
        const point = await run(() => {
          const box = document.querySelector('.tr-scroll').getBoundingClientRect()
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
        })
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          ...point,
          deltaX,
          deltaY,
        })
      }
      const results = []
      for (let round = 0; round < 3; round++) {
        for (const delay of [0, 20, 80, 160, 300, 600]) {
          await run(async () => {
            const p = window.wheelCheck
            await p.open(p.large)
            await p.say('忙一阵')
            await p.sleep(1300)
            document.querySelector('.to-bottom')?.click()
            document.querySelector('.tr-scroll').scrollTop = 0
            await p.sleep(50)
          })
          await wheel(-64)
          await run(async () => {
            const p = window.wheelCheck
            await p.sleep(80)
            await p.open(p.small)
            await p.sleep(100)
            p.row(p.large).click()
            await p.until(
              () =>
                document.querySelector('.crumb')?.textContent.includes(p.large) &&
                document.querySelectorAll('.turn').length > 0 &&
                document.querySelector('.tr-scroll')?.getAttribute('aria-busy') !== 'true',
            )
          })
          await run((delay) => window.wheelCheck.sleep(delay), delay)
          const before = await run(() => window.wheelCheck.mark())
          const deltaX = [0, 40, 64][round]
          await wheel(-48, deltaX)
          await run(() => window.wheelCheck.sleep(350))
          const after = await run((anchor) => window.wheelCheck.mark(anchor), before.anchor)
          const drift = Math.abs(after.offset - before.offset - 48)
          const result = { round, delay, deltaX, drift, before, after }
          results.push(result)
          console.log(JSON.stringify(result))
          assert.ok(drift <= 3, `轻滚 48px 后原文多移动了 ${drift}px`)
          // 只停本夹具的回合，下次确实重新开始工作，不把测试消息变成中途插话。
          await run(async () => {
            document.querySelector('.dock .send.stop')?.click()
            await window.wheelCheck.until(() => !document.querySelector('.dock .send.stop'))
          })
        }
      }
      const nestedPoint = await run(prepareNested)
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        ...nestedPoint,
        deltaX: 0,
        deltaY: 48,
      })
      await run(() => window.wheelCheck.sleep(120))
      const nested = await run(() => ({
        outer: document.querySelector('.tr-scroll').scrollTop,
        inner: document.querySelector('[data-wheel-inner]').scrollTop,
      }))
      assert.equal(nested.outer, -200, '内部滚动不应移动对话')
      assert.equal(nested.inner, 128, '内部滚动仍由浏览器处理')
      await run(() => {
        document.querySelector('[data-wheel-inner]').scrollTop = 0
      })
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        ...nestedPoint,
        deltaX: 0,
        deltaY: -48,
      })
      await run(() => window.wheelCheck.sleep(120))
      assert.equal(
        await run(() => document.querySelector('.tr-scroll').scrollTop),
        -248,
        '内部滚动到顶后继续向上，应滚动对话',
      )
      await run(() => {
        const inner = document.querySelector('[data-wheel-inner]')
        Object.assign(inner.firstElementChild.style, { width: '900px', height: '40px' })
        inner.scrollLeft = 80
      })
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        ...nestedPoint,
        deltaX: 40,
        deltaY: 48,
      })
      await run(() => window.wheelCheck.sleep(120))
      const diagonal = await run(() => ({
        outer: document.querySelector('.tr-scroll').scrollTop,
        inner: document.querySelector('[data-wheel-inner]').scrollLeft,
      }))
      assert.equal(diagonal.outer, -248, '内层横向滚动应保留浏览器的滚动归属')
      assert.equal(diagonal.inner, 120, '斜向手势不能吞掉代码块的横向位移')
      await run(() => {
        const inner = document.querySelector('[data-wheel-inner]')
        inner.scrollLeft = inner.scrollWidth
      })
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        ...nestedPoint,
        deltaX: 64,
        deltaY: -48,
      })
      await run(() => window.wheelCheck.sleep(120))
      assert.equal(
        await run(() => document.querySelector('.tr-scroll').scrollTop),
        -248,
        '内层横向到边缘后，斜向手势也不应突然滚走对话',
      )
      await run(() => document.querySelector('[data-wheel-inner]').remove())
      const gestures = await run(checkOtherGestures)
      assert.ok(gestures.every(Boolean), '横向、缩放、Shift 手势不能被接管')
      const beforeSmall = await run(() => document.querySelector('.tr-scroll').scrollTop)
      for (let index = 0; index < 12; index++) await wheel(-2)
      await run(() => window.wheelCheck.sleep(120))
      const afterSmall = await run(() => document.querySelector('.tr-scroll').scrollTop)
      assert.equal(afterSmall - beforeSmall, -24, '连续小幅滚轮位移必须完整累计')
      console.log(
        JSON.stringify({ nested, diagonal, gestures, smallWheelDelta: afterSmall - beforeSmall }),
      )
      if (process.env.LITCH_WHEEL_RESULT)
        writeFileSync(process.env.LITCH_WHEEL_RESULT, `${JSON.stringify(results, null, 2)}\n`)
      app.exit(0)
    } catch (error) {
      console.error(error)
      app.exit(1)
    }
  })
}

function prepareNested() {
  const outer = document.querySelector('.tr-scroll')
  outer.scrollTop = -200
  const box = outer.getBoundingClientRect()
  const inner = document.createElement('div')
  inner.dataset.wheelInner = ''
  // 几何夹具：模拟代码输出内自己的滚动区，不改应用样式或真实消息。
  Object.assign(inner.style, {
    position: 'fixed',
    left: `${box.left + 80}px`,
    top: `${box.top + 80}px`,
    width: '240px',
    height: '120px',
    overflow: 'auto',
    zIndex: '100',
  })
  const content = document.createElement('div')
  content.style.height = '600px'
  inner.append(content)
  outer.append(inner)
  inner.scrollTop = 80
  return { x: box.left + 100, y: box.top + 100 }
}

function checkOtherGestures() {
  const scroller = document.querySelector('.tr-scroll')
  return [{ deltaX: 48 }, { deltaY: -48, ctrlKey: true }, { deltaY: -48, shiftKey: true }].map(
    (input) => {
      const top = scroller.scrollTop
      const accepted = scroller.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ...input,
        }),
      )
      return accepted && scroller.scrollTop === top
    },
  )
}

async function install() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (check) => {
    const deadline = performance.now() + 20_000
    while (performance.now() < deadline) {
      if (check()) return
      await sleep(10)
    }
    throw new Error(`等待超时：${check}`)
  }
  const row = (title) =>
    [...document.querySelectorAll('.ss-row')].find((node) => node.textContent.includes(title))
  const large = '远程设备安装指引'
  const small = '发版前的检查清单'
  const open = async (title) => {
    row(title).click()
    await until(
      () =>
        document.querySelector('.crumb')?.textContent.includes(title) &&
        document.querySelector('.dock textarea.cmp-text'),
    )
    await sleep(100)
  }
  const say = async (text) => {
    const input = document.querySelector('.dock textarea.cmp-text')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(30)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }
  const mark = (anchor) => {
    const scroller = document.querySelector('.tr-scroll')
    const box = scroller.getBoundingClientRect()
    const node = anchor
      ? scroller.querySelector(`[data-anchor="${CSS.escape(anchor)}"]`)
      : [...scroller.querySelectorAll('[data-anchor]')].find(
          (node) =>
            node.checkVisibility({ contentVisibilityAuto: true }) &&
            node.getBoundingClientRect().bottom > box.top,
        )
    if (!node) throw new Error(`锚点不存在：${anchor}`)
    return {
      anchor: node.getAttribute('data-anchor'),
      offset: node.getBoundingClientRect().top - box.top,
      top: scroller.scrollTop,
      turns: scroller.querySelectorAll('.turn').length,
    }
  }
  window.wheelCheck = { sleep, until, row, open, say, mark, large, small }
  await until(() => row(large))
  window.__litchLook.set({ skin: 'retro', chatText: 1.2, treeText: 1.2 })
  await open(large)
  await say('造长历史')
  await until(() => document.querySelectorAll('.turn').length >= 300)
  await sleep(350)
}
