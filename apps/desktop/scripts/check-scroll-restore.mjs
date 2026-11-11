// 回合结尾的首帧恢复：隐藏窗口、隔离配置、正式滚动 hook；不连接真实设备或保留验收文件。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureEnvironment } from '../../../scripts/fixture-environment.mjs'
import { withChromiumTestArgs } from '../../../third_party/litch-automation/scripts/chromium-test-args.mjs'

const require = createRequire(import.meta.url)
if (!process.versions.electron) {
  const { createServer } = await import('../../../packages/ui/node_modules/vite/dist/node/index.js')
  const scratch = mkdtempSync(join(tmpdir(), 'litch-scroll-restore-'))
  const server = await createServer({
    root: fileURLToPath(new URL('../../../packages/ui', import.meta.url)),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  })
  await server.listen()
  const child = spawn(require('electron'), withChromiumTestArgs([fileURLToPath(import.meta.url)]), {
    env: {
      ...fixtureEnvironment(),
      HOME: scratch,
      CODEX_HOME: join(scratch, 'codex'),
      LITCH_RESTORE_PROFILE: join(scratch, 'profile'),
      LITCH_RESTORE_URL: server.resolvedUrls.local[0],
      LITCH_WHEEL_CPU: process.env.LITCH_WHEEL_CPU ?? '1',
    },
    stdio: 'inherit',
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000)
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
  app.setPath('userData', process.env.LITCH_RESTORE_PROFILE)
  void app.whenReady().then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 900,
      webPreferences: { sandbox: true, backgroundThrottling: false },
    })
    const run = (fn) => win.webContents.executeJavaScript(`(${fn})()`)
    try {
      await win.loadURL(`${process.env.LITCH_RESTORE_URL}test/scroll-restore-fixture.html`)
      win.webContents.debugger.attach('1.3')
      await win.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', {
        rate: Number(process.env.LITCH_WHEEL_CPU),
      })
      const result = await run(probe)
      assert.equal(result.departed.turns, 306)
      assert.equal(result.restored.turns, 12, '必须覆盖首帧只挂载部分回合')
      assert.ok(Math.abs(result.departed.offset + 20) <= 1, '结尾必须有一部分在视口上方')
      assert.ok(Math.abs(result.restoreDrift) <= 1, `回合结尾首帧偏移：${JSON.stringify(result)}`)
      assert.equal(result.restored.visible, true, '恢复目标必须真正参与排版')
      assert.ok(Math.abs(result.rawDrift + 34) <= 1, '必须复现上屏前的 34px 几何变化')
      assert.ok(Math.abs(result.paintedDrift) <= 1, '尺寸补偿必须在上屏前完成')
      const point = await run(() => {
        const rect = document.querySelector('.tr-scroll').getBoundingClientRect()
        return { x: rect.left + 4, y: rect.top + rect.height / 2 }
      })
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        ...point,
        deltaX: 0,
        deltaY: -48,
      })
      const after = await run(() => window.restoreCheck.frameMark())
      assert.ok(
        Math.abs(after.offset - result.restored.offset - 48) <= 1,
        '首帧之后轻滚必须只有 48px',
      )
      console.log('LITCH_SCROLL_RESTORE', JSON.stringify({ ...result, after }))
    } catch (error) {
      console.error(error)
      process.exitCode = 1
    } finally {
      win.destroy()
      app.exit(process.exitCode ?? 0)
    }
  })
}

async function probe() {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  const painted = () => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)))
  const until = async (check) => {
    const end = performance.now() + 10_000
    while (!check()) {
      if (performance.now() > end) throw new Error('恢复夹具未就绪')
      await sleep(10)
    }
  }
  await until(() => window.restoreCheck && document.querySelector('.turn'))
  const p = window.restoreCheck
  const scroller = () => document.querySelector('.tr-scroll')
  const target = () => document.querySelector('[data-anchor="t:299"]')
  const mark = () => ({
    offset: target().getBoundingClientRect().top - scroller().getBoundingClientRect().top,
    top: scroller().scrollTop,
    turns: document.querySelectorAll('.turn').length,
    visible: target().checkVisibility({ contentVisibilityAuto: true }),
  })
  const frameMark = () =>
    new Promise((resolve) => {
      const observer = new ResizeObserver(() => {
        observer.disconnect()
        const sample = mark()
        setTimeout(() => resolve(sample), 0)
      })
      observer.observe(document.querySelector('.tr'))
    })
  Object.assign(p, { frameMark })
  p.open('long')
  await painted()
  target().scrollIntoView({ block: 'start', behavior: 'instant' })
  scroller().scrollTop += 20
  await painted()
  await painted()
  const departed = mark()
  p.open('small')
  await painted()
  p.open('long', true)
  await until(() => scroller().getAttribute('aria-busy') !== 'true')
  // 只跨过首个绘制帧；不能轮询到稳定后再验恢复。
  const restored = await frameMark()
  // 确定性重现工作提示出现时的取样竞争：同步提交增加 34px，紧接着读到的是补偿前几何。
  // 先离开尺寸通知阶段，不能在观察器的微任务里再改尺寸造成循环通知。
  await painted()
  p.grow()
  const raw = mark()
  const shown = await frameMark()
  return {
    departed,
    restored,
    restoreDrift: restored.offset - departed.offset,
    rawDrift: raw.offset - restored.offset,
    paintedDrift: shown.offset - restored.offset,
  }
}
