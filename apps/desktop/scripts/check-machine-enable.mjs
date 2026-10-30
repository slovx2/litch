// M13：隐藏 Electron 窗口、隔离主目录，正式卡片和核心；不启动真实 harness，不改真实设置。
// npm run check:machine-enable；M13_SHOTS 可指定中英文截图的目录。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repo = fileURLToPath(new URL('../../..', import.meta.url))
const self = fileURLToPath(import.meta.url)

if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const folder = mkdtempSync(join(tmpdir(), 'litch-m13-'))
  const shots = process.env.M13_SHOTS ?? join(repo, '.local/m13/shots')
  mkdirSync(shots, { recursive: true })
  try {
    await build({
      entryPoints: [join(repo, 'packages/ui/test/machine-enable-preview.tsx')],
      outfile: join(folder, 'preview.js'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      jsx: 'automatic',
      nodePaths: [join(repo, 'packages/ui/node_modules')],
      alias: { '@litch/core': join(repo, 'packages/core/src/index.mts') },
      loader: { '.woff2': 'dataurl', '.png': 'dataurl' },
    })
    writeFileSync(
      join(folder, 'index.html'),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="preview.css"></head><body><div id="root"></div><script type="module" src="preview.js"></script></body></html>',
    )
    const child = spawn(require('electron'), [self, folder, shots], {
      env: { ...process.env, HOME: folder, CODEX_HOME: join(folder, '.codex') },
      stdio: 'inherit',
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    const code = await new Promise((resolve) => child.once('exit', resolve))
    clearTimeout(timer)
    assert.equal(code, 0, '隐藏窗口验收失败')
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
} else {
  // 不在入口模块顶层等待 app.ready；Electron 要先完成入口模块的求值。
  void runWindow()
}

async function runWindow() {
  const { app, BrowserWindow } = await import('electron')
  const [, , folder, shots] = process.argv
  app.setPath('userData', join(folder, 'profile'))
  app.dock?.hide()
  await app.whenReady()
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  })
  const errors = []
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message)
  })
  const js = (source) => win.webContents.executeJavaScript(source)
  const until = async (source) => {
    const end = Date.now() + 15_000
    while (Date.now() < end) {
      if (await js(source)) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`等不到：${source}\n${await js('document.body.innerText')}`)
  }
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  try {
    for (const lang of ['zh-CN', 'en']) {
      await win.loadFile(join(folder, 'index.html'), { query: { lang } })
      await until('window.__litchLook && document.querySelector(".ss-row")')
      await js(
        `window.__litchLook.set({skin:'standard', theme:'light', lang:${JSON.stringify(lang)}})`,
      )
      await click('.ss-row')
      await until('document.querySelector(".turn")')
      await js('window.m13.call()')
      await until('document.querySelector(".mach-card")')
      const card = '[data-client-ask="machine"]'
      const text = await js(`document.querySelector('${card}').innerText`)
      assert.match(text, /Build server/)
      assert.match(text, /Review local build output/)
      assert.match(text, /ls -la \/fixture\/build/)
      assert.match(text, lang === 'zh-CN' ? /开启并继续/ : /Enable and continue/)
      assert.match(text, lang === 'zh-CN' ? /不允许/ : /Don’t allow/)
      assert.equal(await js('window.m13.state().executions'), 0)
      // 键盘上无目标的回车不能意外开启权限。
      await js(
        'document.body.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", bubbles:true}))',
      )
      assert.equal(await js('window.m13.state().persisted?.tools?.remote?.machine ?? false'), false)
      await js(`document.querySelector('${card}').scrollIntoView({block:'center'})`)
      await new Promise((resolve) => setTimeout(resolve, 200))
      writeFileSync(join(shots, `M13-${lang}.png`), (await win.webContents.capturePage()).toPNG())
      if (lang === 'zh-CN') {
        // 设置入口定位到开关所在分区，但不修改它；全局卡仍能找到。
        await js(
          `Array.from(document.querySelectorAll('${card} button')).find(b => b.textContent.includes('打开设置页')).click()`,
        )
        await until('document.querySelector("[data-sec=tools]")')
        assert.equal(
          await js('window.m13.state().persisted?.tools?.remote?.machine ?? false'),
          false,
        )
        await click('.ss-row')
        await until('document.querySelector(".mach-card")')
        await click(`${card} [data-option="once"]`)
        await until('window.m13.state().persisted?.tools?.remote?.machine === true')
        assert.equal(await js('window.m13.state().persisted.machine.remote.access'), 'sensitive')
        assert.equal(await js('window.m13.state().persisted.machine.remote.approval'), 'each')
        assert.equal(await js('window.m13.state().executions'), 0)
        await until(
          `document.querySelector('${card}') && !document.querySelector('${card}').innerText.includes('开启并继续')`,
        )
        await click(`${card} [data-option="once"]`)
        await until('window.m13.state().result !== null')
        assert.equal(await js('window.m13.state().executions'), 1)
      } else {
        await click(`${card} [data-option="decline"]`)
        await until('window.m13.state().result !== null')
        assert.equal(await js('window.m13.state().executions'), 0)
        assert.match(await js('JSON.stringify(window.m13.state().result)'), /litch:disabled/)
      }
      assert.deepEqual(errors, [], '界面控制台不应报错')
      console.log(`M13 ${lang}：卡片、按钮、状态与截图通过`)
    }
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    win.destroy()
    app.exit(process.exitCode ?? 0)
  }
}
