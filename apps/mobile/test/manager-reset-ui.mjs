// 正式接班组件的 RN Web 窄屏验收；仅驱动本脚本创建的隔离 Chrome。
// 用法：node apps/mobile/test/manager-reset-ui.mjs [预览地址] [截图目录]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, until } from '../../../scripts/chrome-m0/cdp.mjs'
import { withChromiumTestArgs } from '../../../third_party/litch-automation/scripts/chromium-test-args.mjs'

const base = process.argv[2] ?? 'http://127.0.0.1:5189/?app=1&scene=manager-reset'
const output = process.argv[3] ?? join(process.cwd(), '.artifacts/manager-reset-mobile')
mkdirSync(output, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'manager-reset-mobile-'))
const binary =
  process.env.LITCH_CHROME_BINARY ??
  globSync(
    join(
      homedir(),
      'Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ),
  )
    .sort()
    .at(-1)
assert.ok(binary, '需要隔离的 Chrome for Testing')
const child = spawn(
  binary,
  withChromiumTestArgs([
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--no-first-run',
    'about:blank',
  ]),
  {
    env: { HOME: work, PATH: '/usr/bin:/bin', TMPDIR: work },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
)
let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += String(chunk)
})
let cdp
let diagnose
try {
  const ws = await until(
    () => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1],
    '隔离浏览器',
  )
  cdp = await Cdp.connect(ws)
  const target = (await cdp.call('Target.getTargets')).targetInfos.find(
    (one) => one.type === 'page',
  )
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const call = (method, params) => cdp.call(method, params, sessionId)
  cdp.listeners.add((message) => {
    if (message.method === 'Runtime.exceptionThrown')
      console.error('页面错误', JSON.stringify(message.params))
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')
      console.error('页面日志', JSON.stringify(message.params.args))
  })
  await call('Runtime.enable')
  diagnose = () =>
    call('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true })
  const read = async (expression) => {
    await call('Runtime.evaluate', {
      expression: `document.querySelector('[data-testid="ai-consent:allow"]')?.click()`,
    })
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const wait = (expression) => until(() => read(expression), expression, 60000)
  const exists = (id) => `!!document.querySelector('[data-testid="${id}"]')`
  const click = async (id) => {
    await wait(exists(id))
    await read(`document.querySelector('[data-testid="${id}"]').click()`)
  }
  const text = () => read('document.body.innerText')
  const shot = async (name) => {
    await new Promise((resolve) => setTimeout(resolve, 350))
    await read(
      'document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))',
    )
    const png = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(output, `${name}.png`), Buffer.from(png.data, 'base64'))
  }
  const open = async (lang, phase = 'settings') => {
    await call('Page.navigate', { url: `${base}&lang=${lang}&phase=${phase}` })
    await wait('!!window.__managerReset')
  }
  const fits = async () => {
    assert.ok(
      await read(
        `[...document.querySelectorAll('[data-testid="manager-reset-settings"], [data-testid="manager-reset-status"], [role="radio"]')].filter(e=>e.getBoundingClientRect().height).every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})`,
      ),
      '390pt 下设置项和状态无横向截断',
    )
  }
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  })
  for (const lang of ['zh-CN', 'en']) {
    await open(lang)
    for (const skin of ['standard', 'human', 'retro']) {
      await open(lang)
      await read(`window.__litchLook.set({skin:'${skin}',theme:'light'})`)
      await click('manager:reset')
      await wait(exists('manager-reset-settings'))
      await wait(
        `document.querySelector('[data-testid="manager-reset-harness:codex"]')?.getAttribute('aria-disabled')!=='true'`,
      )
      assert.equal(
        await read(
          `document.querySelector('[data-testid="manager-reset-harness:pi"]').getAttribute('aria-disabled')`,
        ),
        'true',
      )
      assert.ok(
        await read(
          `document.querySelector('[data-testid="manager-reset-harness:pi"]').getAttribute('aria-label').length>5`,
        ),
        '不可选原因进入读屏名称',
      )
      await click('manager-reset-harness:codex')
      await wait(
        `document.querySelector('[data-testid="manager-reset-model:gpt-6.1"]')?.getAttribute('aria-disabled')!=='true'`,
      )
      await fits()
      await shot(`${skin}-${lang}-settings`)
      await click('manager-reset-effort:high')
      await wait(
        `document.querySelector('[data-testid="manager-reset-effort:high"]')?.getAttribute('aria-checked')==='true'`,
      )
      await read(
        `document.querySelector('[data-testid="manager-reset-effort:high"]').scrollIntoView({block:'center'})`,
      )
      await shot(`${skin}-${lang}-settings-model`)
      await read(
        `document.querySelector('[data-testid="manager-reset-next"]').scrollIntoView({block:'end'})`,
      )
      await shot(`${skin}-${lang}-settings-dispatch`)
      await click('manager-reset-next')
      await wait(exists('confirm:ok'))
      const detail = await text()
      assert.ok(
        detail.includes('Claude Code') && detail.includes('Codex') && detail.includes('gpt-6.1'),
      )
      assert.ok(detail.includes(lang === 'en' ? 'Capability changes' : '能力变化'))
      assert.ok(detail.includes(lang === 'en' ? 'Workline' : '工作线默认设置变化'))
      assert.ok(
        !detail.includes(
          lang === 'en' ? 'Keeps the conversation and full history' : '保留当前会话和完整历史',
        ),
      )
      await shot(`${skin}-${lang}-confirm`)
      await read(
        `document.querySelector('[data-testid="confirm:ok"]').scrollIntoView({block:'end'})`,
      )
      await shot(`${skin}-${lang}-confirm-details`)
      await click('confirm:ok')
      await wait(
        `window.__managerReset.calls.some(([name,p])=>name==='managers.reset' && p.target?.harness==='codex')`,
      )
      const params = await read(
        `window.__managerReset.calls.filter(([name])=>name==='managers.reset').at(-1)[1]`,
      )
      assert.ok(params.requestId && params.expectedSettingsHash && params.expectedThreadId)
      assert.equal(params.target.effort, 'high')
      for (const phase of ['waiting', 'handoverFailed', 'summaryFailed']) {
        await open(lang, phase)
        await read(`window.__litchLook.set({skin:'${skin}',theme:'light'})`)
        if (phase === 'summaryFailed') {
          await click('manager:reset')
          await wait(exists('confirm:ok'))
          assert.ok(!(await read(exists('manager-reset-settings'))), '摘要失败不再打开目标选择')
          assert.ok((await text()).includes('Codex'))
        } else {
          await wait(exists('manager-reset-status'))
          assert.ok((await text()).includes('Claude Code') && (await text()).includes('Codex'))
          if (phase === 'waiting') assert.ok(await read(exists('manager:reset-cancel')))
        }
        await fits()
        await shot(`${skin}-${lang}-${phase}`)
        if (phase === 'waiting') {
          await click('manager:reset-cancel')
          await wait(`window.__managerReset.calls.some(([name])=>name==='managers.reset.cancel')`)
          await wait(`!document.querySelector('[data-testid="manager-reset-status"]')`)
        } else if (phase === 'summaryFailed') {
          const locked = await read('window.__managerReset.manager.reset.operation')
          await click('confirm:ok')
          await wait(
            `window.__managerReset.calls.some(([name,p])=>name==='managers.reset'&&p.boardOnly)`,
          )
          const retry = await read(
            `window.__managerReset.calls.filter(([name])=>name==='managers.reset').at(-1)[1]`,
          )
          assert.deepEqual(retry.target, locked.target, '摘要失败后的提交保留已确认目标')
          assert.equal(retry.requestId, locked.requestId)
        }
      }
    }
    await open(lang, 'old-device')
    await click('manager:reset')
    await wait(exists('confirm:ok'))
    assert.ok(!(await read(exists('manager-reset-settings'))), '旧设备保留直接确认')
    assert.ok((await text()).includes(lang === 'en' ? 'full history' : '完整历史'))
  }
  console.log(
    '通过：390pt，三皮肤×中英文，选择/有损确认/等待取消/摘要失败锁定/接班失败/旧设备；截图：' +
      output,
  )
} catch (error) {
  console.error(await diagnose?.())
  console.error(error)
  throw error
} finally {
  cdp?.close()
  child.kill('SIGTERM')
}
