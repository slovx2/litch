// 隐藏 Electron 窗口、隔离 HOME；正式 UI 与模拟核心，不打开系统文件管理器、不保留证据文件。
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
  const work = mkdtempSync(join(tmpdir(), 'litch-file-destination-'))
  const server = await createServer({
    root: fileURLToPath(new URL('../../../packages/ui', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const child = spawn(require('electron'), withChromiumTestArgs([fileURLToPath(import.meta.url)]), {
    env: {
      ...fixtureEnvironment(),
      HOME: work,
      CODEX_HOME: join(work, 'codex'),
      LITCH_FILE_PROFILE: join(work, 'profile'),
      LITCH_FILE_URL: server.resolvedUrls.local[0],
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
    rmSync(work, { recursive: true, force: true })
  }
} else {
  const { app, BrowserWindow } = require('electron')
  app.setPath('userData', process.env.LITCH_FILE_PROFILE)
  void app.whenReady().then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 1300,
      height: 1000,
      webPreferences: { sandbox: true, backgroundThrottling: false },
    })
    try {
      await win.loadURL(
        `${process.env.LITCH_FILE_URL}test/file-destination-fixture.html?lang=zh-CN`,
      )
      const result = await win.webContents.executeJavaScript(`(${probe})()`)
      assert.equal(result.platforms, 3)
      assert.ok(result.reveals >= 10)
      assert.equal(result.saves, 4)
      assert.equal(win.isVisible(), false)
      console.log(
        'PASS 隐藏窗口：三平台文案、本机文件/目录、源码/预览顶栏与菜单、对话链接、附件、删除提示、远程另存及保存结果动作',
        result,
      )
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
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (check) => {
    const end = Date.now() + 10_000
    while (Date.now() < end) {
      if (check()) return
      await wait(20)
    }
    throw Error(`等待界面超时：${String(check)}\n${document.body.innerText.slice(-900)}`)
  }
  const assert = (condition, message) => {
    if (!condition) throw Error(message)
  }
  const click = (selector) => {
    const button = document.querySelector(selector)
    assert(button, `缺少 ${selector}`)
    button.click()
  }
  const context = (element) => {
    assert(element, '缺少菜单目标')
    element.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 250, clientY: 300 }),
    )
  }
  const closeMenu = () =>
    document
      .querySelector('[role="menu"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const treeRow = (name) => document.querySelector(`.ft [role="treeitem"][data-path$="/${name}"]`)
  await until(() => window.fileFixture)
  const fixture = window.fileFixture
  for (const platform of ['darwin', 'win32', 'linux']) {
    fixture.configure('local', platform)
    const label = platform === 'darwin' ? '在 Finder 中打开' : '在文件管理器中打开'
    await until(
      () => document.querySelector('.fv-head [data-tool="reveal-local"]')?.title === label,
    )
    assert(!document.querySelector('[data-tool="save-local"]'), '本机不得显示另存')
    click('.fv-head [data-tool="reveal-local"]')
    await until(() => treeRow('Makefile'))
    context(treeRow('Makefile'))
    await until(() => document.querySelector('[data-action="revealLocal"]'))
    assert(
      document.querySelector('[data-action="revealLocal"]').textContent === label,
      '菜单平台文案',
    )
    assert(!document.querySelector('[data-action="saveLocal"]'), '本机菜单不得显示另存')
    click('[data-action="revealLocal"]')
    await until(() => treeRow('cmd'))
    context(treeRow('cmd'))
    await until(() => document.querySelector('[data-action="revealLocal"]'))
    click('[data-action="revealLocal"]')
    assert(fixture.calls.at(-1).path.endsWith('/cmd'), '目录直接使用目录自身')
    click('[data-card="sent"] [data-tool="reveal-local"]')
    if (platform === 'win32') {
      click('[data-card="windows"] [data-tool="reveal-local"]')
      assert(fixture.calls.at(-1).root === 'C:/Users/dev', 'Windows 附件父目录必须规范化')
      assert(fixture.calls.at(-1).path === 'C:/Users/dev/report.txt', 'Windows 附件路径')
    }
    click('[data-card="root"] [data-tool="reveal-local"]')
    assert(fixture.calls.at(-1).path === '/', '根目录附件打开自身')
  }
  // 对话链接正常打开渲染预览，文件管理器动作同样可用。
  click('a.file-link')
  await until(
    () =>
      document.querySelector('.fv-file')?.dataset.path.endsWith('/README.md') &&
      document.querySelector('.fv-file')?.dataset.state === 'ready',
  )
  assert(document.querySelector('.fv-head [data-tool="reveal-local"]'), '渲染预览顶栏')
  context(document.querySelector('.fv-file'))
  await until(() => document.querySelector('[data-action="revealLocal"]'))
  click('[data-action="revealLocal"]')
  fixture.result('missing')
  click('.fv-head [data-tool="reveal-local"]')
  await until(() => document.querySelector('.toast-text')?.textContent.includes('已不存在'))
  fixture.result('opened')
  fixture.configure('build', 'darwin')
  await until(() =>
    document.querySelector('[data-fixture-device="build"] .fv-head [data-tool="save-local"]'),
  )
  assert(!document.querySelector('.fv-head [data-tool="reveal-local"]'), '远程同名路径不得打开本机')
  assert(
    document.querySelector('[data-card="client"] [data-tool="reveal-local"]'),
    '远程会话的本机附件归属本机',
  )
  await until(() => treeRow('Makefile'))
  context(treeRow('Makefile'))
  await until(() => document.querySelector('[data-action="saveLocal"]'))
  click('[data-action="saveLocal"]')
  await until(() => treeRow('cmd'))
  context(treeRow('cmd'))
  await until(() => document.querySelector('[role="menu"]'))
  assert(
    !document.querySelector('[data-action="saveLocal"], [data-action="revealLocal"]'),
    '远程目录没有另存或本机打开',
  )
  closeMenu()
  click('.fv-head [data-tool="save-local"]')
  click('[data-card="sent"] [data-tool="save-local"]')
  click('a.file-link')
  await until(
    () =>
      document.querySelector('.fv-file')?.dataset.path.endsWith('/README.md') &&
      document.querySelector('.fv-file')?.dataset.state === 'ready',
  )
  context(document.querySelector('.fv-file'))
  await until(() => document.querySelector('[data-action="saveLocal"]'))
  click('[data-action="saveLocal"]')
  await until(() => document.querySelector('.toast-text')?.textContent.includes('/client/report'))
  const actions = document.querySelectorAll('.toast-act')
  actions[0].click()
  actions[1].click()
  assert(fixture.saveActions.join(',') === 'open,reveal', '保存后的打开和显示文件夹仍可用')
  assert(
    fixture.saves.every((source) => source.deviceId === 'build'),
    '另存来源设备',
  )
  return { platforms: 3, reveals: fixture.calls.length, saves: fixture.saves.length }
}
