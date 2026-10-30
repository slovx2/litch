// 对话字号回归：隐藏窗口、浏览器模拟核心、隔离配置，不启动真实设备。
// 可选 LITCH_TEXT_SHOTS 指定截图目录。运行前 npm run client:build。
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
  const { preview } = await import('../../../packages/ui/node_modules/vite/dist/node/index.js')
  const scratch = mkdtempSync(join(tmpdir(), 'litch-text-scale-'))
  const server = await preview({
    root: fileURLToPath(new URL('../../../packages/ui', import.meta.url)),
    preview: { host: '127.0.0.1', port: 0, strictPort: false },
  })
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url)], {
    env: {
      ...fixtureEnvironment(),
      HOME: scratch,
      CODEX_HOME: join(scratch, 'codex'),
      LITCH_TEXT_PROFILE: join(scratch, 'profile'),
      LITCH_TEXT_URL: server.resolvedUrls.local[0],
      LITCH_TEXT_SHOTS: process.env.LITCH_TEXT_SHOTS ?? '',
    },
    stdio: 'inherit',
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 180_000)
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
  app.setPath('userData', process.env.LITCH_TEXT_PROFILE)
  void app.whenReady().then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 950,
      webPreferences: { sandbox: true, backgroundThrottling: false },
    })
    const run = (fn, ...args) =>
      win.webContents.executeJavaScript(
        `(${fn})(${args.map((arg) => JSON.stringify(arg)).join(',')})`,
      )
    const shot = async (name) => {
      const dir = process.env.LITCH_TEXT_SHOTS
      if (!dir) return
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `M7-${name}.png`), (await win.webContents.capturePage()).toPNG())
    }
    try {
      await win.loadURL(`${process.env.LITCH_TEXT_URL}?lang=zh-CN&onboarding=off`)
      await run(install)
      await run(async () => {
        await window.m7.open('远程设备安装指引')
        await window.m7.say('给我一段能评论的回答')
        await window.m7.until(
          () =>
            !document.querySelector('.running-line') &&
            document.querySelector('.tr')?.textContent.includes('每次立刻重来'),
        )
      })
      const results = []
      for (const skin of ['retro', 'human', 'standard']) {
        await run(
          (skin) => window.__litchLook.set({ skin, theme: 'light', chatText: 1, treeText: 1 }),
          skin,
        )
        await run(() => window.m7.comment())
        const normal = await run(measure)
        if (skin === 'retro') await shot('comment-default')
        await run(() => window.__litchLook.set({ chatText: 1.5 }))
        await run(() => window.m7.settle())
        const large = await run(measure)
        for (const selector of Object.keys(normal.fonts)) {
          assert.ok(
            Math.abs(large.fonts[selector] / normal.fonts[selector] - 1.5) < 0.01,
            `${skin} ${selector} 字号没有跟随`,
          )
        }
        assert.ok(large.inside, `${skin} 评论编辑框越界`)
        assert.ok(large.buttonsFit, `${skin} 评论按钮裁字`)
        results.push({ skin, normal, large })
        await shot(`comment-max-${skin}`)
        await run(() =>
          document
            .querySelector('.cmt-edit-text')
            .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
        )
      }
      // 右下角和低矮窗口下重新定位，引用展开、长评论仍可滚动访问按钮。
      win.setSize(760, 540)
      await run(() => window.m7.comment())
      await run(() => document.querySelector('.cmt-edit-more')?.click())
      await run(() => window.m7.settle())
      assert.ok((await run(measure)).inside, '窄窗口评论框越界')
      await shot('comment-max-narrow')
      await run(() => document.querySelector('.cmt-edit [data-act="save"]').click())
      win.setSize(1200, 950)
      await run(async () => {
        await window.m7.say('请按评论回应')
        await window.m7.until(
          () => document.querySelector('.cmt-cite') && !document.querySelector('.running-line'),
        )
        const cite = document.querySelector('.cmt-cite')
        cite.scrollIntoView({ block: 'center' })
        cite.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
        await window.m7.until(() => document.querySelector('.cmt-peek'))
        await window.m7.settle()
      })
      await shot('citation-max')
      win.setSize(760, 540)
      assert.ok(
        await run(async () => {
          await window.m7.settle()
          const peek = document.querySelector('.cmt-peek')
          const rect = peek.getBoundingClientRect()
          return (
            getComputedStyle(peek).fontSize === '18px' &&
            rect.left >= 7 &&
            rect.right <= innerWidth - 7 &&
            rect.top >= 7 &&
            rect.bottom <= innerHeight - 7
          )
        }),
        '引用预览字号或窗口边界错误',
      )
      await shot('citation-max-narrow')
      await run(() =>
        document
          .querySelector('.cmt-cite')
          .dispatchEvent(new MouseEvent('mouseout', { bubbles: true })),
      )
      win.setSize(1200, 950)
      await run(async () => {
        await window.m7.open('发版前的检查清单')
        await window.m7.say('边做边问：跑一下测试')
        await window.m7.until(() => document.querySelectorAll('.pending-ask').length === 2)
      })
      await shot('questions-composer-max')
      await run(async () => {
        document.querySelector('.dock .pick-btn')?.click()
        await window.m7.settle()
      })
      await shot('picker-max')
      await run(async () => {
        document.querySelector('.dock .pick-btn')?.click()
        const input = document.querySelector('.dock .cmp-text')
        const data = new DataTransfer()
        data.setData(
          'text/plain',
          Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行：需要检查的构建日志`).join('\n'),
        )
        input.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        )
        await window.m7.until(() => document.querySelector('.dock .cmp-chip-open'))
        document.querySelector('.dock .cmp-chip-open').click()
        await window.m7.settle()
      })
      await shot('attachment-max')
      await run(async () => {
        await window.m7.open('远程设备安装指引')
        for (const close of document.querySelectorAll('.dock .cmp-chip-x')) close.click()
        await window.m7.say('起两个后台任务')
        await window.m7.until(() => document.querySelector('.main .bgbar'))
        document.querySelector('.main .bgbar').click()
        await window.m7.until(() => document.querySelector('.bg-panel'))
        await window.m7.settle()
      })
      await shot('background-max')
      const boundaries = await run(checkBoundaries)
      assert.deepEqual(boundaries, [], '共享样式和区域边界回归')
      console.log(JSON.stringify({ ok: true, results }, null, 2))
    } catch (error) {
      console.error(error)
      await shot('failure')
      process.exitCode = 1
    } finally {
      win.destroy()
      app.exit(process.exitCode ?? 0)
    }
  })
}

// 以下函数整体送入页面，不引用外部变量。
async function install() {
  const until = async (check) => {
    const end = Date.now() + 30_000
    while (Date.now() < end) {
      if (check()) return
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    throw new Error(`字号验收等待超时：${check}`)
  }
  const settle = async () => {
    await document.fonts.ready
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  const open = async (title) => {
    await until(() =>
      [...document.querySelectorAll('.ss-row')].some((row) => row.textContent.includes(title)),
    )
    ;[...document.querySelectorAll('.ss-row')]
      .find((row) => row.textContent.includes(title))
      .click()
    await until(
      () =>
        document.querySelector('.crumb')?.textContent.includes(title) &&
        document.querySelector('.dock .cmp-text'),
    )
    await settle()
  }
  const say = async (value) => {
    const input = document.querySelector('.dock .cmp-text')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }
  const comment = async () => {
    const answers = [...document.querySelectorAll('.tr [data-comment-item]')]
    const answer = answers.findLast((node) => node.textContent.includes('每次立刻重来'))
    answer.scrollIntoView({ block: 'center' })
    const range = document.createRange()
    range.selectNodeContents(answer)
    getSelection().removeAllRanges()
    getSelection().addRange(range)
    answer.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    await until(() => document.querySelector('.cmt-pop [data-act="comment"]'))
    await settle()
    const rect = document.querySelector('.cmt-pop').getBoundingClientRect()
    if (rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight)
      throw new Error('选字浮层越界')
    document.querySelector('.cmt-pop [data-act="comment"]').click()
    await until(() => document.activeElement === document.querySelector('.cmt-edit-text'))
    await settle()
  }
  window.m7 = { until, settle, open, say, comment }
  await until(() => window.__litchLook && document.querySelector('.ss-row'))
}

function measure() {
  const fonts = {}
  for (const selector of [
    '.cmt-edit-quote',
    '.cmt-edit-more',
    '.cmt-edit-text',
    '.cmt-edit-hint',
    '.cmt-edit [data-act="save"]',
    '.dock .cmp-text',
  ]) {
    const element = document.querySelector(selector)
    if (!element) throw new Error(`缺少 ${selector}`)
    fonts[selector] = Number.parseFloat(getComputedStyle(element).fontSize)
  }
  const rect = document.querySelector('.cmt-edit').getBoundingClientRect()
  return {
    fonts,
    inside:
      rect.left >= 7 &&
      rect.right <= innerWidth - 7 &&
      rect.top >= 7 &&
      rect.bottom <= innerHeight - 7,
    buttonsFit: [...document.querySelectorAll('.cmt-edit button')].every(
      (button) => button.clientHeight >= button.scrollHeight - 1,
    ),
  }
}

async function checkBoundaries() {
  const errors = []
  // 组件的边界组合：覆盖 portal、覆盖规则、对话内共享控件与侧面板，另查外壳不受影响。
  const cases = [
    ['cmt-pop', 'button', true],
    ['cmt-peek', 'cmt-peek-note', true],
    ['dock', 'pick-pop pick-opt', true],
    ['dock', 'sug sug-opt', true],
    ['dock', 'peek peek-body', true],
    ['dock', 'cmp-chip', true],
    ['req-frame', 'req-rule', true],
    ['pending-asks', 'pending-ask-q', true],
    ['tr', 'ask-q', true],
    ['tr', 'item-head', true],
    ['tr', 'code-head', true],
    ['tr', 'dl', true],
    ['tr', 'well-gap', true],
    ['tr', 'well-blob', true],
    ['req-frame', 'step', true],
    ['tr', 'modal confirm confirm-body', true],
    ['aside-view', 'aside-label', true],
    ['aside-view', 'aside-lead', true],
    ['agents-view', 'agents-task-text', true],
    ['goal-panel', 'goal-label', true],
    ['bg-panel', 'bg-row', true],
    ['sb', 'pick-pop pick-opt', false],
    ['info-card', 'info-head', false],
  ]
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-10000px;width:600px'
  document.body.append(host)
  try {
    for (const skin of ['retro', 'human', 'standard']) {
      for (const [parentClass, childClass, follows] of cases) {
        const parent = document.createElement('div')
        parent.className = parentClass
        const child = document.createElement('div')
        child.className = childClass
        child.textContent = '对话文字 Typography'
        parent.append(child)
        host.replaceChildren(parent)
        window.__litchLook.set({ skin, chatText: 1 })
        const normal = Number.parseFloat(getComputedStyle(child).fontSize)
        window.__litchLook.set({ chatText: 1.5 })
        const large = Number.parseFloat(getComputedStyle(child).fontSize)
        if (Math.abs(large / normal - (follows ? 1.5 : 1)) > 0.01)
          errors.push(`${skin} ${parentClass} / ${childClass}: ${normal} → ${large}`)
        if (
          ['well-gap', 'well-blob', 'step'].includes(childClass) &&
          child.clientHeight < Number.parseFloat(getComputedStyle(child).lineHeight)
        )
          errors.push(`${skin} ${childClass}: 行高超过容器`)
      }
    }
  } finally {
    host.remove()
  }
  return errors
}
