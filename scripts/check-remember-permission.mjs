// 隐藏 Electron + 模拟核心验收新建权限；不连接真实设备，不保留截图或个人状态。
// node scripts/check-remember-permission.mjs（需已安装 ui、desktop 依赖）
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureEnvironment } from './fixture-environment.mjs'

const require = createRequire(import.meta.url)
const root = dirname(dirname(fileURLToPath(import.meta.url)))

async function probe() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (label, check) => {
    for (let i = 0; i < 200; i++) {
      if (check()) return check()
      await sleep(50)
    }
    throw new Error(`等不到${label}：${document.body.innerText.slice(-1500)}`)
  }
  const picker = (kind) => document.querySelector(`.pick[data-kind="${kind}"] .pick-btn`)
  const choose = async (kind, id, confirmed = false) => {
    ;(await until(kind, () => picker(kind))).click()
    const option = await until(id, () =>
      document.querySelector(`.pick[data-kind="${kind}"] [data-option="${id}"]`),
    )
    option.click()
    if (confirmed) {
      ;(await until('确认权限', () => document.querySelector('.pick-ask-actions .danger'))).click()
    }
    await sleep(160)
  }
  const area = () => document.querySelector('textarea.cmp-text')
  const type = (value) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area(), value)
    area().dispatchEvent(new Event('input', { bubbles: true }))
  }
  await until('权限', () => picker('permission'))
  const later = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Later',
  )
  later?.click()
  await choose('permission', ':danger-full-access', true)
  const full = picker('permission').textContent
  await choose('harness', 'pi')
  const cross = picker('permission').textContent
  type('permission memory probe')
  await until('可发送', () => !document.querySelector('.cmp .send')?.disabled)
  document.querySelector('.cmp .send').click()
  await until('已建会话', () => !document.querySelector('.new-hero'))
  document.querySelector('.sb-link.new').click()
  await until('再次新建', () => document.querySelector('.new-hero') && picker('permission'))
  const reopened = picker('permission').textContent
  await choose('harness', 'claude')
  await choose('permission', ':read-only')
  await choose('harness', 'pi')
  type('must not escalate')
  await sleep(100)
  const independent = {
    permission: picker('permission').textContent,
    alert: document.querySelector('[role="alert"]')?.textContent,
    disabled: document.querySelector('.cmp .send')?.disabled,
  }
  // Pi 的唯一档位免确认；换回 Claude 仍记着只读，且同范围确认未丢失。
  await choose('permission', ':danger-full-access')
  const piNoConfirmation = !document.querySelector('.pick-ask')
  await choose('harness', 'claude')
  const claudeRemembered = picker('permission').textContent
  await choose('permission', ':danger-full-access')
  const rememberedConfirmation = !document.querySelector('.pick-ask')
  // 远程设备独立记录；同一个前端无需自己的 home 路径。
  await choose('device', 'build')
  const remoteDefault = picker('permission').textContent
  await choose('permission', ':danger-full-access', true)
  await choose('harness', 'pi')
  const remoteCross = picker('permission').textContent
  return {
    full,
    cross,
    reopened,
    independent,
    piNoConfirmation,
    claudeRemembered,
    rememberedConfirmation,
    remoteDefault,
    remoteCross,
  }
}

if (process.versions.electron) {
  const { app, BrowserWindow } = require('electron')
  app.setPath('userData', join(process.env.HOME, 'electron'))
  void app.whenReady().then(async () => {
    app.dock?.hide()
    const window = new BrowserWindow({
      show: false,
      width: 1360,
      height: 860,
      webPreferences: { backgroundThrottling: false },
    })
    try {
      await window.loadURL(process.env.LITCH_FIXTURE_PERMISSION_URL)
      const result = await window.webContents.executeJavaScript(`(${probe.toString()})()`)
      for (const key of ['full', 'cross', 'reopened', 'remoteCross'])
        assert.equal(result[key], 'Full access')
      assert.equal(result.independent.permission, 'Full access')
      assert.equal(result.independent.alert, undefined)
      assert.equal(result.independent.disabled, false)
      assert.equal(result.piNoConfirmation, true)
      assert.equal(result.claudeRemembered, 'Read only')
      assert.equal(result.rememberedConfirmation, true)
      assert.equal(result.remoteDefault, 'Workspace')
      console.log(JSON.stringify(result))
    } catch (error) {
      console.error(error)
      process.exitCode = 1
    } finally {
      window.destroy()
      app.exit(process.exitCode ?? 0)
    }
  })
} else {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  const home = mkdtempSync(join(tmpdir(), 'litch-permission-'))
  const env = {
    ...fixtureEnvironment(),
    HOME: home,
    CODEX_HOME: join(home, 'codex'),
    LITCH_FIXTURE_PERMISSION_URL: `http://127.0.0.1:${port}/?lang=en`,
  }
  const vite = spawn(
    process.execPath,
    [
      join(root, 'packages/ui/node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: join(root, 'packages/ui'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  vite.stdout.on('data', (chunk) => {
    output += chunk
  })
  vite.stderr.on('data', (chunk) => {
    output += chunk
  })
  let electron
  try {
    for (let i = 0; !output.includes('Local:'); i++) {
      if (i > 200 || vite.exitCode !== null) throw new Error(`Vite 未启动：${output}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    electron = spawn(
      require('../apps/desktop/node_modules/electron'),
      [fileURLToPath(import.meta.url)],
      {
        cwd: root,
        env,
        stdio: 'inherit',
      },
    )
    const timeout = setTimeout(() => electron.kill('SIGTERM'), 60_000)
    const [code] = await once(electron, 'exit')
    clearTimeout(timeout)
    assert.equal(code, 0, '隐藏窗口权限验收失败')
  } finally {
    if (electron && electron.exitCode === null) electron.kill('SIGTERM')
    vite.kill('SIGTERM')
    await once(vite, 'close')
    rmSync(home, { recursive: true, force: true })
  }
}
