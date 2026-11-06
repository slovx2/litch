// 回到底部、轻滚、切会话再切回、再次轻滚：必须用真实滚轮输入，直接改 scrollTop 抓不到合成线程的坐标错位。
// 先构建 UI。隐藏窗口、隔离 HOME、模拟核心；不连接真实设备。可用 LITCH_WHEEL_RESULT 保存测量结果。
// LITCH_WHEEL_CPU=4 可在渲染进程中降速，复查绘制与取样的先后顺序。
import './require-ui-build.mjs'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureEnvironment } from '../../../scripts/fixture-environment.mjs'

const require = createRequire(import.meta.url)
if (!process.versions.electron) {
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL('./check-scroll-restore.mjs', import.meta.url))],
    {
      stdio: 'inherit',
    },
  )
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
      LITCH_WHEEL_CPU: process.env.LITCH_WHEEL_CPU ?? '1',
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
    rmSync(scratch, { recursive: true, force: true })
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
    const painted = () =>
      run(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0))))
    try {
      await win.loadURL(`${process.env.LITCH_WHEEL_URL}?lang=zh-CN&onboarding=off`)
      await run(install)
      win.webContents.debugger.attach('1.3')
      await win.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', {
        rate: Number(process.env.LITCH_WHEEL_CPU),
      })
      const wheel = async (deltaY, deltaX = 0, edge = false) => {
        const point = await run((edge) => {
          const box = document.querySelector('.tr-scroll').getBoundingClientRect()
          return { x: box.left + (edge ? 4 : box.width / 2), y: box.top + box.height / 2 }
        }, edge)
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
          const departed = await run(async () => {
            const p = window.wheelCheck
            await p.sleep(80)
            const departed = await p.frameMark()
            await p.open(p.small)
            await p.sleep(100)
            p.row(p.large).click()
            await p.until(
              () =>
                document.querySelector('.crumb')?.textContent.includes(p.large) &&
                document.querySelectorAll('.turn').length > 0 &&
                document.querySelector('.tr-scroll')?.getAttribute('aria-busy') !== 'true',
            )
            return departed
          })
          // aria-busy 只表示锚点所在的回合已挂载。content-visibility 的占位高度要到
          // 本帧布局、ResizeObserver 补偿后才成为画面；不能把尚未绘制的几何当作轻滚基线。
          // 只跨过首次绘制，不轮询到位置稳定；首帧恢复错了仍必须失败。
          const restored = await run(
            (anchor) => window.wheelCheck.frameMark(anchor),
            departed.anchor,
          )
          const restoreDrift = Math.abs(restored.offset - departed.offset)
          assert.ok(
            restoreDrift <= 3,
            `切回首帧原文移动了 ${restoreDrift}px：${JSON.stringify({ departed, restored })}`,
          )
          await run((delay) => window.wheelCheck.sleep(delay), delay)
          // 状态行在切回后延迟出现，会先增加 34px，再由 ResizeObserver 在上屏前补偿。
          // 计时器结束时直接量可能恰好读到这段未绘制的位移，误报成滚轮多滚了 34px。
          const before = await run(() => window.wheelCheck.frameMark())
          const deltaX = [0, 40, 64][round]
          await wheel(-48, deltaX)
          await run(() => window.wheelCheck.sleep(350))
          const after = await run((anchor) => window.wheelCheck.frameMark(anchor), before.anchor)
          const drift = Math.abs(after.offset - before.offset - 48)
          const result = {
            round,
            delay,
            deltaX,
            restoreDrift,
            drift,
            departed,
            restored,
            before,
            after,
          }
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
      // 停止按钮消失只表示输入区已更新，过程收尾的布局与滚动补偿还可能没画完。
      // 先等最后一轮画出结束状态并跨过绘制，再设置内层测试的 -200 基线，否则前一阶段的补偿
      // 会在真实滚轮到达前把它改成 -191（停止时状态行变矮了约 9px）。
      await run(() =>
        window.wheelCheck.until(() => document.querySelector('.turn:last-child > .turn-foot')),
      )
      await painted()
      const nestedPoint = await run(prepareNested)
      // 新建的内层滚动区先上屏，合成线程才会把真实滚轮命中它。
      await painted()
      const nestedBefore = await run(() => ({
        outer: document.querySelector('.tr-scroll').scrollTop,
        inner: document.querySelector('[data-wheel-inner]').scrollTop,
      }))
      assert.deepEqual(nestedBefore, { outer: -200, inner: 80 }, '内层测试的初始位置尚未就绪')
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        ...nestedPoint,
        deltaX: 0,
        deltaY: 48,
      })
      await run(() => window.wheelCheck.sleep(120))
      // 原生滚动由合成线程提交；降速时计时器可能先到，取下一次绘制后的实际位置。
      await painted()
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
      await painted()
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
      await painted()
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
      await painted()
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
      await painted()
      const afterSmall = await run(() => document.querySelector('.tr-scroll').scrollTop)
      assert.equal(afterSmall - beforeSmall, -24, '连续小幅滚轮位移必须完整累计')
      console.log(
        JSON.stringify({ nested, diagonal, gestures, smallWheelDelta: afterSmall - beforeSmall }),
      )
      // 与待办贴底探针同样延迟 scroll 通知，用 CDP 真实滚轮确认用户不点按钮也能恢复跟随。
      await run(prepareDelayedFollow)
      await wheel(-240, 0, true)
      await painted()
      await run(() => window.wheelCheck.delayScroll())
      await wheel(100000, 0, true)
      const follow = await run(() => window.wheelCheck.measureFollow())
      assert.ok(follow.trusted, '必须由真实滚轮输入恢复跟随')
      assert.ok(follow.delayed > 0, '必须实际延迟 scroll 事件')
      assert.ok(follow.done && follow.heights >= 3, '必须覆盖待办变长、变短直到完成')
      assert.ok(follow.maxDistance <= 1, `滚轮到底后没有恢复跟随：${JSON.stringify(follow)}`)
      assert.ok(follow.spread <= 0.5, `事件延迟期间贴底波动：${JSON.stringify(follow)}`)
      results.push({ delayedScrollFollow: follow })
      console.log(JSON.stringify({ delayedScrollFollow: follow }))
      if (process.env.LITCH_WHEEL_RESULT)
        writeFileSync(process.env.LITCH_WHEEL_RESULT, `${JSON.stringify(results, null, 2)}\n`)
      app.exit(0)
    } catch (error) {
      console.error(error)
      app.exit(1)
    }
  })
}

async function prepareDelayedFollow() {
  const p = window.wheelCheck
  window.__litchRail?.set(false)
  await p.say('列一份待办，验证滚轮回到底部')
  const card = () => document.querySelector('.turn:last-child .todo')
  const count = () => card()?.querySelector('.todo-count')?.textContent ?? ''
  await p.until(() => count().includes('0/4'))
  const scroller = document.querySelector('.tr-scroll')
  let delayed = 0
  let trusted = false
  const hold = (event) => {
    delayed++
    event.stopImmediatePropagation()
  }
  const wheel = (event) => {
    trusted ||= event.isTrusted && event.deltaY > 0
  }
  p.delayScroll = () => {
    if (scroller.scrollTop >= -1 || !document.querySelector('.to-bottom'))
      throw new Error('滚轮恢复前必须真的处于自由阅读状态')
    scroller.addEventListener('scroll', hold, true)
    scroller.addEventListener('wheel', wheel, true)
  }
  p.measureFollow = async () => {
    const samples = []
    const heights = new Set()
    const deadline = performance.now() + 15000
    try {
      do {
        // 跨过绘制，尺寸变化的取样在应用自己的 ResizeObserver 补偿之后。
        await new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)))
        const content = document.querySelector('.tr')
        samples.push({
          gap: content.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom,
          top: scroller.scrollTop,
        })
        heights.add(Math.round(card()?.getBoundingClientRect().height ?? 0))
      } while (!count().includes('5/5') && performance.now() < deadline)
      const gaps = samples.map((sample) => sample.gap)
      return {
        trusted,
        delayed,
        done: count().includes('5/5'),
        heights: heights.size,
        maxDistance: Math.max(...samples.map((sample) => Math.abs(sample.top))),
        spread: Math.max(...gaps) - Math.min(...gaps),
      }
    } finally {
      scroller.removeEventListener('scroll', hold, true)
      scroller.removeEventListener('wheel', wheel, true)
    }
  }
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
    [...document.querySelectorAll('.ss-row:not(.projection-group *)')].find((node) =>
      node.textContent.includes(title),
    )
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
            node.getBoundingClientRect().bottom > box.top &&
            node.getBoundingClientRect().top < box.bottom,
        )
    if (!node) throw new Error(`锚点不存在：${anchor}`)
    return {
      anchor: node.getAttribute('data-anchor'),
      offset: node.getBoundingClientRect().top - box.top,
      top: scroller.scrollTop,
      turns: scroller.querySelectorAll('.turn').length,
    }
  }
  // 新观察器必定收到下一次布局通知，且排在产品的尺寸补偿之后。必须在回调内取样：
  // rAF 后的 setTimeout 与 React 提交交错时，回调外再量仍可能读到下一次补偿前的几何。
  const frameMark = (anchor) =>
    new Promise((resolve) => {
      const observer = new ResizeObserver(() => {
        observer.disconnect()
        const sample = mark(anchor)
        // 数值在通知内保存，后续切会话等操作则放到绘制后，避免在尺寸通知中再改 DOM。
        setTimeout(() => resolve(sample), 0)
      })
      observer.observe(document.querySelector('.tr'))
    })
  window.wheelCheck = { sleep, until, row, open, say, mark, frameMark, large, small }
  await until(() => row(large))
  window.__litchLook.set({ skin: 'retro', chatText: 1.2, treeText: 1.2 })
  await open(large)
  await say('造长历史')
  await until(() => document.querySelectorAll('.turn').length >= 300)
  await sleep(350)
}
