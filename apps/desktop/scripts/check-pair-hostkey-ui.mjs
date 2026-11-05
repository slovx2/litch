// 隐藏 Electron 窗口验收正式配对对话框，隔离 HOME 和用户数据。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureEnvironment } from '../../../scripts/fixture-environment.mjs'

const require = createRequire(import.meta.url)
if (!process.versions.electron) {
  const { createServer } = await import('../../../packages/ui/node_modules/vite/dist/node/index.js')
  const work = mkdtempSync(join(tmpdir(), 'litch-pair-ui-'))
  const server = await createServer({
    root: fileURLToPath(new URL('../../../packages/ui', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url)], {
    env: {
      ...fixtureEnvironment(),
      HOME: work,
      CODEX_HOME: join(work, 'codex'),
      LITCH_PAIR_PROFILE: join(work, 'profile'),
      LITCH_PAIR_URL: server.resolvedUrls.local[0],
      ...(process.env.LITCH_PAIR_SHOTS ? { LITCH_PAIR_SHOTS: process.env.LITCH_PAIR_SHOTS } : {}),
    },
    stdio: 'inherit',
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 90000)
  try {
    process.exitCode = await new Promise((resolve) =>
      child.on('exit', (code) => resolve(code ?? 1)),
    )
  } finally {
    clearTimeout(timeout)
    await server.close()
    rmSync(work, { recursive: true, force: true })
  }
} else {
  const { app, BrowserWindow } = require('electron')
  app.setPath('userData', process.env.LITCH_PAIR_PROFILE)
  void app.whenReady().then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 1060,
      height: 1000,
      webPreferences: { sandbox: true, backgroundThrottling: false },
    })
    try {
      for (const reason of ['mismatch', 'unknown', 'unverified']) {
        await win.loadURL(
          `${process.env.LITCH_PAIR_URL}test/pair-hostkey-fixture.html?reason=${reason}`,
        )
        const result = await win.webContents.executeJavaScript(`(${probe})()`)
        assert.equal(result, true)
        if (reason === 'mismatch' && process.env.LITCH_PAIR_SHOTS) {
          mkdirSync(process.env.LITCH_PAIR_SHOTS, { recursive: true })
          for (const skin of ['standard', 'retro', 'human']) {
            await win.webContents.executeJavaScript(
              `window.__litchLook.set({ skin: '${skin}', lang: 'zh-CN' }); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
            )
            writeFileSync(
              join(process.env.LITCH_PAIR_SHOTS, `${skin}.png`),
              (await win.webContents.capturePage()).toPNG(),
            )
          }
        }
      }
      await win.loadURL(`${process.env.LITCH_PAIR_URL}test/pair-hostkey-fixture.html?ttl=900`)
      assert.equal(await win.webContents.executeJavaScript(`(${expiryProbe})()`), true)
      assert.equal(win.isVisible(), false)
      console.log(
        'PASS 隐藏窗口：三种风险、取消、一次确认出码、中英三皮肤、改地址隐藏旧码、到期重新确认',
      )
      app.exit(0)
    } catch (error) {
      console.error(error)
      app.exit(1)
    }
  })
}

async function probe() {
  const wait = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`界面等待超时：${document.body.innerText}`)
  }
  const click = (selector) => {
    const element = document.querySelector(selector)
    if (!element) throw new Error(selector)
    element.click()
  }
  const ready = () => document.querySelector('[data-pair-ready="true"]')
  await wait(() => document.querySelector('[data-pair-host-warning]'))
  if (ready()) throw new Error('确认前出码')
  for (const skin of ['standard', 'retro', 'human']) {
    for (const lang of ['zh-CN', 'en']) {
      window.__litchLook.set({ skin, lang })
      if (window.__litchLook.get().skin !== skin) throw new Error('皮肤未生效')
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const confirm = document.querySelector('[data-act="pair-host-confirm"]')
      if (!confirm?.textContent.includes(lang === 'en' ? 'Confirm' : '确认'))
        throw new Error('确认文案未翻译')
      for (const row of document.querySelectorAll('.pair-fingerprint')) {
        if (row.scrollWidth > row.clientWidth + 1) throw new Error('指纹溢出')
      }
    }
  }
  click('[data-act="pair-host-cancel"]')
  await wait(() => !document.querySelector('dialog'))
  if (window.pairHostFixture.calls.some((call) => call.args?.hostKeyConfirmation))
    throw new Error('取消发了确认')
  click('[data-reopen]')
  await wait(() => document.querySelector('[data-pair-host-warning]'))
  click('[data-act="pair-host-confirm"]')
  await wait(ready)
  if (window.pairHostFixture.calls.filter((call) => call.args?.hostKeyConfirmation).length !== 1)
    throw new Error('确认次数不对')
  const input = document.querySelector('[data-field="host"] input')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, '10.0.3.12')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((resolve) => requestAnimationFrame(resolve))
  if (ready()) throw new Error('新地址仍显示旧码')
  await wait(() => document.querySelector('[data-pair-host-warning]'))
  const last = window.pairHostFixture.calls.filter((call) => call.name === 'pairing.start').at(-1)
  if (last.args.hostKeyConfirmation) throw new Error('地址变更复用了确认')
  return true
}

async function expiryProbe() {
  const wait = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('到期流程超时')
  }
  await wait(() => document.querySelector('[data-act="pair-host-confirm"]'))
  document.querySelector('[data-act="pair-host-confirm"]').click()
  await wait(() => document.querySelector('[data-pair-ready="true"]'))
  await wait(() => document.querySelector('[data-pair-host-warning]'))
  if (document.querySelector('[data-pair-ready="true"]')) throw new Error('到期仍显示码')
  const starts = window.pairHostFixture.calls.filter((call) => call.name === 'pairing.start')
  if (starts.at(-1).args.hostKeyConfirmation) throw new Error('到期复用了确认')
  return true
}
