// 正式手机设备页 + 模拟核心；隔离无头浏览器，不使用用户浏览器或真实设备连接。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MODEL_RANKING_ENABLED } from '../packages/protocol/src/model-ranking.mts'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'
import { removeTestTree } from './ci/remove-test-tree.mjs'

const repo = resolve(import.meta.dirname, '..')
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
assert.ok(binary, '需要隔离 Chrome for Testing')
const reservation = createServer()
await new Promise((resolve, reject) => {
  reservation.once('error', reject)
  reservation.listen(0, '127.0.0.1', resolve)
})
const { port } = reservation.address()
await new Promise((resolve, reject) => {
  reservation.close((error) => (error ? reject(error) : resolve()))
})
const work = mkdtempSync(join(tmpdir(), 'model-ranking-ui-'))
const env = { ...process.env }
delete env.CI
const server = spawn(
  process.execPath,
  ['node_modules/expo/bin/cli', 'start', '--web', '--offline', '--port', String(port)],
  {
    cwd: join(repo, 'apps/mobile'),
    env: {
      ...env,
      EXPO_NO_TELEMETRY: '1',
      EXPO_NO_DOTENV: '1',
      EXPO_NO_TYPESCRIPT_SETUP: '1',
      EXPO_PUBLIC_LITCH_E2E: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
let serverOutput = ''
for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', (chunk) => {
    serverOutput = (serverOutput + chunk).slice(-8192)
  })
}
let browser, cdp
try {
  const exited = new Promise((resolve) => {
    server.once('close', resolve)
    server.once('error', resolve)
  })
  const ready = await Promise.race([
    until(
      async () => {
        if (!serverOutput.includes(`Waiting on http://localhost:${port}`)) return false
        try {
          const response = await fetch(`http://127.0.0.1:${port}`, {
            signal: AbortSignal.timeout(2000),
          })
          await response.body?.cancel()
          return response.ok
        } catch {
          return false
        }
      },
      '手机预览',
      60000,
    ),
    exited,
  ])
  assert.equal(ready, true, 'Expo 在手机预览就绪前退出')
  browser = spawn(
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
  let output = ''
  browser.stderr.on('data', (data) => {
    output += data
  })
  cdp = await Cdp.connect(
    await until(() => output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], '隔离浏览器'),
  )
  const page = (await cdp.call('Target.getTargets')).targetInfos.find(
    (target) => target.type === 'page',
  )
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: page.targetId,
    flatten: true,
  })
  const call = (method, params) => cdp.call(method, params, sessionId)
  const read = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await call('Page.navigate', {
    url: `http://127.0.0.1:${port}/?app=1&scene=device&lang=zh-CN&skin=standard`,
  })
  await until(
    () =>
      read(
        `Boolean(document.querySelector('[data-testid="manage"] [data-testid="harness:codex:settings"]'))`,
      ),
    '正式设备设置及 harness 列表',
    60000,
  )
  if (!MODEL_RANKING_ENABLED) {
    assert.equal(
      await read(`Boolean(document.querySelector('[data-testid="model-ranking"]'))`),
      false,
    )
    console.log('手机 390px：设备设置和 harness 列表已载入，模型等级排序入口未显示')
  } else {
    const body = () =>
      read(`document.querySelector('[data-testid="model-ranking"]')?.textContent??''`)
    // 动作单、确认框挂在页面最外层，按 testID 在整页里找
    const tap = async (testID) => {
      try {
        await until(
          () =>
            read(
              `(()=>{const el=document.querySelector('[data-testid=${JSON.stringify(testID)}]');if(!el||el.getAttribute('aria-disabled')==='true')return false;el.click();return true})()`,
            ),
          testID,
          60000,
        )
      } catch (error) {
        console.error(await read('document.body.innerText'))
        throw error
      }
      await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    }
    await tap('ranking:toggle')
    await until(async () => (await body()).includes('gpt-6-astra'), '预排型号', 60000)
    assert.match(await body(), /内置排序/)
    // 点一行出调级动作单：Luna 上一级，并入 Sol 那一级
    await tap('ranking:model:gpt-6-luna')
    await tap('ranking:action:up')
    assert.match(await body(), /有未保存的修改/)
    await tap('ranking:save')
    await until(
      async () => (await body()).includes('自定义排序') && !(await body()).includes('有未保存'),
      '保存自定义',
    )
    await tap('ranking:toggle')
    await tap('ranking:toggle')
    await until(async () => (await body()).includes('自定义排序'), '重开保留')
    await read(
      `document.querySelector('[data-testid="model-ranking"]').scrollIntoView({block:'start'})`,
    )
    await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    mkdirSync(join(repo, '.artifacts'), { recursive: true })
    const shot = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(repo, '.artifacts/model-cap-mobile.png'), Buffer.from(shot.data, 'base64'))
    await tap('ranking:reset')
    await tap('confirm:ok')
    await until(
      async () => (await body()).includes('内置排序') && !(await body()).includes('自定义排序'),
      '恢复内置',
    )
    console.log('手机 390px：预排、动作单调级、保存自定义、重开保留、恢复内置通过')
  }
} catch (error) {
  console.error(serverOutput)
  throw error
} finally {
  cdp?.close()
  for (const child of [browser, server])
    if (child && child.exitCode === null) {
      child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
    }
  removeTestTree(work)
}
