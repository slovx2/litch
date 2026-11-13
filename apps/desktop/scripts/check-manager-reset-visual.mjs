// 独立隐藏窗口，只访问 Vite 模拟界面；可指定 LITCH_VISUAL_DIR 保存 PNG。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

const profile = mkdtempSync(join(tmpdir(), 'litch-reset-visual-'))
const base = process.env.LITCH_VISUAL_URL ?? 'http://127.0.0.1:5207'
const output = process.env.LITCH_VISUAL_DIR
if (output) mkdirSync(output, { recursive: true })
app.setPath('userData', profile)
app.on('will-quit', () => rmSync(profile, { recursive: true, force: true }))
async function run() {
  await app.whenReady()
  const deadline = setTimeout(() => app.exit(1), 120000)
  const window = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  })
  const evaluate = (fn, ...args) =>
    window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`)
  const wait = async (selector) =>
    evaluate(async (selector) => {
      for (let i = 0; i < 250; i++) {
        if (document.querySelector(selector)) return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`Missing ${selector}`)
    }, selector)
  const shot = async (name) => {
    await evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    const image = await window.webContents.capturePage()
    if (output) writeFileSync(join(output, `${name}.png`), image.toPNG())
    console.log(`RESET_IMAGE ${name}${output ? ` ${join(output, `${name}.png`)}` : ''}`)
  }
  const click = async (selector) => {
    await wait(selector)
    await evaluate((selector) => document.querySelector(selector).click(), selector)
    await evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
  }
  const select = async (selector, value) =>
    evaluate(
      (selector, value) => {
        const field = document.querySelector(selector)
        field.value = value
        field.dispatchEvent(new Event('change', { bubbles: true }))
      },
      selector,
      value,
    )
  try {
    await window.loadURL(base)
    await evaluate(() => document.querySelector('[data-act="onboard-later"]')?.click())
    await click('[data-sidebar-mode="manager"]')
    await click('[data-manager-id="m1"] .mg-pick')
    await wait('[data-act="manager-reset"]')
    for (const lang of ['zh-CN', 'en']) {
      for (const skin of process.env.LITCH_VISUAL_SKIN
        ? [process.env.LITCH_VISUAL_SKIN]
        : ['standard', 'human', 'retro']) {
        await evaluate(
          (skin, lang) => window.__litchLook.set({ skin, lang, theme: 'light' }),
          skin,
          lang,
        )
        await click('[data-act="manager-reset"]')
        await wait('[data-reset-field="harness"]:not(:disabled)')
        const closed = await evaluate(() => !document.querySelector('.reset-target-settings').open)
        if (!closed) throw new Error('Handover settings should start collapsed')
        const initial = await evaluate(() => ({
          title: document.querySelector('dialog[open]').getAttribute('aria-label'),
          enabled: !document.querySelector('.confirm-yes').disabled,
          text: document.querySelector('dialog[open]').textContent,
        }))
        if (
          !initial.enabled ||
          initial.title !== (lang === 'zh-CN' ? '重置经理会话' : 'Reset manager session') ||
          !/完整历史|full history/.test(initial.text)
        )
          throw new Error('Unchanged Claude settings should allow an ordinary refresh')
        await shot(`${skin}-${lang}-current`)
        await click('.reset-target-settings summary')
        await select('[data-reset-field="harness"]', 'codex')
        await wait('[data-reset-field="model"] option[value="gpt-6.1"]')
        await wait('.confirm-yes:not(:disabled)')
        const checks = await evaluate(() => {
          const dialog = document.querySelector('dialog[open]')
          const rect = dialog.getBoundingClientRect()
          const fields = [...dialog.querySelectorAll('select')]
          return {
            rect: {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: innerWidth,
              height: innerHeight,
              sw: dialog.scrollWidth,
              cw: dialog.clientWidth,
            },
            overflow:
              rect.left < 0 ||
              rect.right > innerWidth ||
              rect.top < 0 ||
              rect.bottom > innerHeight ||
              dialog.scrollWidth > dialog.clientWidth,
            fieldOverflow: fields.some((field) => field.getBoundingClientRect().right > rect.right),
            footerHidden:
              dialog.querySelector('.confirm-yes').getBoundingClientRect().bottom > rect.bottom,
            fullHistory: /完整历史|full history/.test(dialog.textContent),
            disabled: [...fields[0].options]
              .filter((option) => option.disabled)
              .map((option) => option.textContent),
          }
        })
        if (
          checks.overflow ||
          checks.fieldOverflow ||
          checks.footerHidden ||
          checks.fullHistory ||
          checks.disabled.length < 4 ||
          checks.disabled.some((text) => !text.includes(' — '))
        )
          throw new Error(JSON.stringify(checks))
        await shot(`${skin}-${lang}-settings`)
        await click('.reset-target-settings summary')
        await evaluate(() => {
          document.querySelector('.confirm-body').scrollTop = 0
        })
        await shot(`${skin}-${lang}-switch`)
        await evaluate(() => {
          const body = document.querySelector('.confirm-body')
          body.scrollTop = body.scrollHeight
        })
        await shot(`${skin}-${lang}-confirm`)
        await click('dialog[open] .pick-ask-actions .ghost')
      }
    }
    console.log('RESET_STAGE bidirectional')
    // 通过正式 App 的 mock 真正提交双向切换，确认重置入口跟随新经理。
    await evaluate(() => window.__litchLook.set({ skin: 'standard', lang: 'zh-CN' }))
    await click('[data-act="manager-reset"]')
    await wait('.confirm-yes:not(:disabled)')
    await click('.reset-target-settings summary')
    await select('[data-reset-field="harness"]', 'codex')
    await wait('[data-reset-field="model"] option[value="gpt-6.1"]')
    await click('.confirm-yes:not(:disabled)')
    await wait('[data-act="manager-reset"]:not(:disabled)')
    await click('[data-act="manager-reset"]')
    await wait('.confirm-yes:not(:disabled)')
    if (
      !(await evaluate(() =>
        document.querySelector('.reset-target-preview > span')?.textContent.startsWith('Codex'),
      ))
    )
      throw new Error('App did not follow the incoming Codex manager')
    await click('.reset-target-settings summary')
    await select('[data-reset-field="harness"]', 'claude-code')
    await wait('[data-reset-field="model"] option[value="claude-sonnet-4-6"]')
    await wait('.confirm-yes:not(:disabled)')
    await click('.reset-target-settings summary')
    await shot('codex-to-claude')
    await click('.confirm-yes')
    await wait('[data-act="manager-reset"]:not(:disabled)')
    await click('[data-act="manager-reset"]')
    await wait('.confirm-yes:not(:disabled)')
    if (
      !(await evaluate(() =>
        document
          .querySelector('.reset-target-preview > span')
          ?.textContent.startsWith('Claude Code'),
      ))
    )
      throw new Error('App did not follow the incoming Claude manager')
    await click('dialog[open] .pick-ask-actions .ghost')
    console.log('RESET_STAGE fixtures')
    // 边界夹具也使用正式组件和真实 mock 预检，记录最终发出的通道参数。
    await window.loadURL(`${base}/test/manager-reset-fixture.html`)
    await wait('[data-act="manager-reset"]')
    await evaluate(() =>
      window.__litchLook.set({ lang: 'zh-CN', skin: 'standard', theme: 'light' }),
    )
    await click('[data-act="manager-reset"]')
    await wait('[data-reset-field="harness"]:not(:disabled)')
    await click('.reset-target-settings summary')
    await select('[data-reset-field="harness"]', 'codex')
    await wait('[data-reset-field="model"] option[value="gpt-6.1"]')
    await click('.confirm-yes:not(:disabled)')
    await wait('dialog[open]')
    await wait('.confirm-yes:not(:disabled)')
    const failed = await evaluate(() => document.querySelector('dialog[open]').textContent)
    if (
      !failed.includes('交接摘要生成失败') ||
      (await evaluate(() => Boolean(document.querySelector('[data-reset-field="harness"]'))))
    )
      throw new Error('Failed summary target was not locked')
    await shot('summary-failed-locked')
    await click('dialog[open] .pick-ask-actions .ghost')
    await evaluate(() => window.__resetFixture.reload())
    await click('[data-act="manager-reset"]')
    await wait('.confirm-yes:not(:disabled)')
    if (await evaluate(() => Boolean(document.querySelector('[data-reset-field="harness"]'))))
      throw new Error('Reload unlocked the handover target')
    await click('.confirm-yes:not(:disabled)')
    const retry = await evaluate(() => window.__resetFixture.requests)
    if (
      retry.length !== 2 ||
      !retry[1].boardOnly ||
      retry[0].requestId !== retry[1].requestId ||
      JSON.stringify(retry[0].target) !== JSON.stringify(retry[1].target) ||
      retry[0].expectedSettingsHash !== retry[1].expectedSettingsHash ||
      retry[0].expectedThreadId !== retry[1].expectedThreadId
    )
      throw new Error('Board-only retry changed confirmed plan')
    await evaluate(() => window.__resetFixture.scenario('resolvedDispatch'))
    await click('[data-act="manager-reset"]')
    await wait('.confirm-yes:not(:disabled)')
    if (
      !(await evaluate(() => document.querySelector('.confirm-yes').textContent === '重置经理会话'))
    )
      throw new Error('Resolved unchanged dispatch was treated as a switch')
    await click('dialog[open] .pick-ask-actions .ghost')
    for (const scenario of ['permissionUnknown', 'blocked', 'delayed']) {
      await evaluate((scenario) => window.__resetFixture.scenario(scenario), scenario)
      await click('[data-act="manager-reset"]')
      await wait('dialog[open]')
      if (scenario !== 'delayed') await wait('[data-reset-field="harness"]')
      const blocked = await evaluate(() => document.querySelector('.confirm-yes').disabled)
      if (!blocked) throw new Error(`Unsafe submit available: ${scenario}`)
      if (scenario === 'delayed') {
        await evaluate(() => window.__resetFixture.release())
        await wait('.confirm-yes:not(:disabled)')
      }
      await click('dialog[open] .pick-ask-actions .ghost')
    }
    await evaluate(() => window.__resetFixture.scenario('previewFailure'))
    await click('[data-act="manager-reset"]')
    await wait('.confirm-yes:not(:disabled)')
    await click('.reset-target-settings summary')
    await select('[data-reset-field="harness"]', 'codex')
    await wait('dialog[open] [role="alert"]')
    if (!(await evaluate(() => document.querySelector('.confirm-yes').disabled)))
      throw new Error('Failed recheck allowed stale preview submission')
    await click('dialog[open] .pick-ask-actions .ghost')
    await evaluate(() => window.__resetFixture.scenario('sameClaude'))
    await click('[data-act="manager-reset"]')
    await wait('.confirm-yes:not(:disabled)')
    await click('.reset-target-settings summary')
    await select('[data-reset-field="model"]', 'claude-opus-fixture')
    await wait('.confirm-yes:not(:disabled)')
    const modelSwitch = await evaluate(() => document.querySelector('dialog[open]').textContent)
    if (!modelSwitch.includes('切换并重置') || modelSwitch.includes('完整历史'))
      throw new Error('Claude model switch used refresh copy')
    await click('dialog[open] .pick-ask-actions .ghost')
    await evaluate(() => window.__resetFixture.scenario('waiting'))
    await click('[data-act="manager-reset"]')
    await wait('.confirm-yes:not(:disabled)')
    await click('.reset-target-settings summary')
    await select('[data-reset-field="harness"]', 'codex')
    await wait('[data-reset-field="model"] option[value="gpt-6.1"]')
    await click('.confirm-yes:not(:disabled)')
    await wait('[data-act="manager-reset-cancel"]:not(:disabled)')
    if (
      !(await evaluate(() =>
        document.querySelector('.reset-target-status')?.textContent.includes('Claude Code → Codex'),
      ))
    )
      throw new Error('Waiting lost confirmed source and target')
    await shot('waiting-target')
    await click('[data-act="manager-reset-cancel"]')
    await wait('[data-act="manager-reset"]')
    await evaluate(() => window.__resetFixture.scenario('handoverFailed'))
    await click('[data-act="manager-reset"]')
    await wait('.confirm-yes:not(:disabled)')
    await click('.confirm-yes')
    await wait('.reset-target-status[role="alert"]')
    await shot('handover-failed')
    console.log(
      'RESET_OK skins=3 languages=2 summaryRetry=locked permissionUnknown=blocked previewFailure=blocked delayedPreview=blocked handoverFailure=shown reload=locked stalePreview=blocked claudeModel=replace waiting=cancelled bidirectional=passed defaultRefresh=passed footer=visible',
    )
  } finally {
    clearTimeout(deadline)
    window.destroy()
    app.quit()
  }
}
void run().catch((error) => {
  console.error(error)
  app.exit(1)
})
