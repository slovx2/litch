// 正式 RN Web 建议抽屉，分页详情与提案动作使用隔离替身。先起 Expo，不设置 CI=1。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'

const url = process.argv[2] ?? 'http://localhost:5227/?app=1&scene=suggestion-detail'
const output = process.env.LITCH_SUGGESTION_DETAIL_OUTPUT ?? '.artifacts/suggestion-detail'
mkdirSync(output, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'suggestion-detail-'))
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
const browser = spawn(
  binary,
  withChromiumTestArgs([
    '--headless=new',
    `--user-data-dir=${work}/profile`,
    '--remote-debugging-port=0',
    '--no-first-run',
    'about:blank',
  ]),
  {
    env: { PATH: process.env.PATH, HOME: work, TMPDIR: work },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
)
let stderr = '',
  cdp
browser.stderr.on('data', (data) => {
  stderr += data
})
try {
  const endpoint = await until(() => /DevTools listening on (ws:\S+)/.exec(stderr)?.[1], 'Chrome')
  cdp = await Cdp.connect(endpoint)
  const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true })
  const call = (method, params) => cdp.call(method, params, sessionId)
  const read = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await call('Runtime.enable')
  await call('Page.enable')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await call('Page.navigate', { url })
  const wait = (expression) => until(() => read(expression), expression, 90000)
  await wait('!!document.querySelector(\'[data-testid="proposal:nebula-detail:start"]\')')
  await wait('document.body.innerText.includes("首次点击工具图片没有打开大图")')
  await wait('document.body.innerText.includes("保留回合展开保护")')
  assert.equal(
    await read('window.__suggestionDetail.calls.filter(c=>c[0]==="managers.board.detail").length'),
    1,
  )
  const click = (id) => read(`document.querySelector('[data-testid="${id}"]').click()`)
  await click('discussion-drawer:size')
  await wait(
    'document.querySelector(\'[data-testid="issue-sheet:S-nebula-detail"]\').getBoundingClientRect().top < 20',
  )
  await read('document.fonts.ready')
  writeFileSync(
    join(output, 'mobile-suggestion-detail.png'),
    Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  )
  await click('proposal:nebula-detail:start')
  await wait('window.__suggestionDetail.calls.some(c=>c[0]==="session.proposal.accept")')
  await click('proposal:nebula-detail:more')
  await wait('!!document.querySelector(\'[data-testid="proposal:nebula-detail:dismiss"]\')')
  writeFileSync(
    join(output, 'mobile-suggestion-actions.png'),
    Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  )
  await click('proposal:nebula-detail:dismiss')
  await wait('window.__suggestionDetail.calls.some(c=>c[0]==="session.proposal.dismiss")')
  writeFileSync(
    join(output, 'calls.json'),
    JSON.stringify(await read('window.__suggestionDetail.calls'), null, 2),
  )
  console.log('PASS 手机分页建议：详情补载、完整简报、工作线已推荐、开始及忽略')
} finally {
  cdp?.close()
  if (browser.exitCode === null) {
    const exited = new Promise((resolve) => browser.once('exit', resolve))
    browser.kill()
    await exited
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
