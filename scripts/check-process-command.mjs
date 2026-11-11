// 真实过程组件的窄宽度验收；手机使用 RN Web 与固定主题/时钟，不执行命令或连接个人设备。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { Cdp, until } from './chrome-m0/cdp.mjs'
import { buildProcessMobileFixture } from './process-command-mobile-fixture.mjs'

const baseline = process.argv.includes('--baseline')
const mobile = process.argv.includes('--mobile')
const mobileFiles = mobile ? await buildProcessMobileFixture() : null
const evidence = process.env.LITCH_PROCESS_EVIDENCE
const root = mkdtempSync(join(tmpdir(), 'nebula-process-command-'))
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
assert.ok(binary)
const server = await createServer({
  plugins: mobileFiles
    ? [
        {
          name: 'process-command-mobile-fixture',
          configureServer(server) {
            server.middlewares.use('/process-command-mobile/', (request, response) => {
              const file =
                request.url?.split('?')[0] === '/fixture.js' ? 'fixture.js' : 'index.html'
              response.setHeader(
                'content-type',
                file.endsWith('.js') ? 'text/javascript' : 'text/html',
              )
              response.end(readFileSync(join(mobileFiles, file)))
            })
          },
        },
      ]
    : [],
  root: new URL('../packages/ui', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 0, hmr: false },
  logLevel: 'error',
})
let browser, cdp
try {
  await server.listen()
  browser = spawn(
    binary,
    withChromiumTestArgs([
      '--headless=new',
      `--user-data-dir=${root}/profile`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--window-size=1200,940',
      'about:blank',
    ]),
    {
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let log = ''
  browser.stderr.on('data', (chunk) => {
    log += chunk
  })
  cdp = await Cdp.connect(
    await until(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], 'Chrome'),
  )
  const target = (await cdp.call('Target.getTargets')).targetInfos.find(
    (one) => one.type === 'page',
  )
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const call = (method, params) => cdp.call(method, params, sessionId)
  cdp.listeners.add((message) => {
    if (message.method === 'Runtime.exceptionThrown') console.error(JSON.stringify(message.params))
  })
  await call('Runtime.enable')
  await call('Log.enable')
  cdp.listeners.add((message) => {
    if (message.method === 'Log.entryAdded') console.error(JSON.stringify(message.params))
  })
  await call('Page.enable')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1200,
    height: 940,
    deviceScaleFactor: 1,
    mobile: false,
  })
  const read = async (expression) => {
    const value = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description)
    return value.result.value
  }
  const wait = (selector) =>
    until(() => read(`!!document.querySelector(${JSON.stringify(selector)})`), selector)
  const click = async (selector) => {
    await wait(selector)
    await read(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  await call('Page.navigate', {
    url: `${server.resolvedUrls.local[0]}${mobile ? 'process-command-mobile/index.html' : 'test/process-command-fixture.html'}`,
  })
  if (mobile) {
    await wait('[data-testid="step:command"]')
    for (const lang of ['zh-CN', 'en']) {
      await read(`window.__mobileCommand.lang(${JSON.stringify(lang)})`)
      if (!baseline) {
        assert.equal(
          await read(
            `document.body.innerText.includes('正在运行') || document.body.innerText.includes('Running:')`,
          ),
          false,
        )
        assert.equal(
          await read(`document.querySelectorAll('[role="img"][aria-label]').length>=4`),
          true,
        )
        for (const width of [240, 320, 380]) {
          const measured = await read(
            `(()=>{document.querySelector('#root > div').style.width='${width}px';const row=document.querySelector('[data-testid="step:command"]');const text=[...row.children].find(e=>e.textContent.startsWith('$'));return {clipped:text.scrollWidth>text.clientWidth,ellipsis:getComputedStyle(text).textOverflow,overflow:row.scrollWidth>row.clientWidth+1}})()`,
          )
          assert.equal(measured.clipped, true)
          assert.equal(measured.ellipsis, 'ellipsis')
          assert.equal(measured.overflow, false)
        }
        await read(`document.querySelector('#root > div').style.width='320px'`)
      }
      if (evidence) {
        mkdirSync(evidence, { recursive: true })
        const shot = await call('Page.captureScreenshot', { format: 'png' })
        writeFileSync(
          join(evidence, `mobile-${baseline ? 'before' : 'after'}-${lang}-collapsed.png`),
          Buffer.from(shot.data, 'base64'),
        )
      }
      await click('[data-testid="step:command"]')
      if (!baseline) {
        await wait('[data-testid="command-source"]')
        assert.equal(
          await read(`document.body.innerText.includes('Streaming nebula output')`),
          false,
        )
        assert.ok(
          await read(
            `document.querySelector('[data-testid="command-source"]').textContent.includes('detailed-results.json')`,
          ),
        )
        if (evidence) {
          const shot = await call('Page.captureScreenshot', { format: 'png' })
          writeFileSync(
            join(evidence, `mobile-after-${lang}-no-output.png`),
            Buffer.from(shot.data, 'base64'),
          )
        }
        await read('window.__mobileCommand.output()')
        await until(
          () => read(`document.body.innerText.includes('Streaming nebula output')`),
          '手机过程输出',
        )
      }
      if (evidence) {
        const shot = await call('Page.captureScreenshot', { format: 'png' })
        writeFileSync(
          join(evidence, `mobile-${baseline ? 'before' : 'after'}-${lang}-expanded.png`),
          Buffer.from(shot.data, 'base64'),
        )
      }
      await click('[data-testid="step:command"]')
    }
    console.log('PASS mobile narrow process rows')
  } else {
    await wait('[data-case="inProgress"] .steps-head')
    for (const lang of ['zh-CN', 'en']) {
      await read(
        'window.__litchLook.set(' + JSON.stringify({ skin: 'human', theme: 'dark', lang }) + ')',
      )
      if (!baseline) {
        assert.equal(
          await read(`document.querySelector('[data-case="inProgress"] .steps-head .sum')`),
          null,
        )
        assert.ok(
          await read(
            `document.querySelector('[data-case="inProgress"] .step-mark').getAttribute("aria-label")`,
          ),
        )
        const geometry = await read(
          `(()=>{const e=document.querySelector('[data-case="inProgress"] .now');return {ellipsis:getComputedStyle(e).textOverflow,clipped:e.scrollWidth>e.clientWidth}})()`,
        )
        assert.equal(geometry.ellipsis, 'ellipsis')
        assert.equal(geometry.clipped, true)
        for (const width of [240, 320, 380]) {
          assert.equal(
            await read(
              `(()=>{document.querySelector('main').style.width='${width}px';const e=document.querySelector('[data-case="inProgress"] .steps-head');return e.scrollWidth<=e.clientWidth+1})()`,
            ),
            true,
          )
        }
        await read(`document.querySelector('main').style.width='320px'`)
        await read('window.__processCommand.waiting(true)')
        await wait('[data-case="inProgress"] .steps-head .st.wait')
        assert.equal(
          await read(
            `document.querySelector('[data-case="inProgress"] .steps-head .step-mark').getAttribute('aria-label')`,
          ),
          lang === 'zh-CN' ? '待审批' : 'Needs approval',
        )
        assert.equal(
          await read(
            `document.querySelector('[data-case="inProgress"] .steps-head [data-elapsed]')`,
          ),
          null,
        )
        await read('window.__processCommand.waiting(false)')
        await wait('[data-case="inProgress"] .steps-head .st.run')
      }
      if (evidence) {
        mkdirSync(evidence, { recursive: true })
        const shot = await call('Page.captureScreenshot', { format: 'png' })
        writeFileSync(
          join(evidence, (baseline ? 'before' : 'after') + '-' + lang + '-collapsed.png'),
          Buffer.from(shot.data, 'base64'),
        )
      }
      for (const head of ['inProgress', 'completed', 'failed', 'declined']) {
        await click('[data-case="' + head + '"] .steps-head')
        await click('[data-case="' + head + '"] .item-head')
        if (!baseline) {
          await wait('[data-case="' + head + '"] [data-command-source]')
          assert.ok(
            await read(
              `document.querySelector('[data-case="${head}"] [data-command-source]').textContent.includes("detailed-results.json")`,
            ),
          )
          assert.ok(await read(`document.querySelector('[data-case="${head}"] .step-mark').title`))
          assert.equal(
            await read(
              `(()=>{const e=document.querySelector('[data-case="${head}"] [data-command-source]');return getComputedStyle(e).userSelect==='text' && e.scrollWidth<=e.clientWidth+1})()`,
            ),
            true,
          )
          assert.equal(
            await read(
              `document.querySelector('[data-case="${head}"] .item-head').innerText.includes("运行") || document.querySelector('[data-case="${head}"] .item-head').innerText.includes("Running")`,
            ),
            false,
          )
        }
      }
      if (!baseline) {
        assert.equal(
          await read(`document.querySelectorAll('[data-case="inProgress"] .well').length`),
          0,
        )
        if (evidence) {
          const shot = await call('Page.captureScreenshot', { format: 'png' })
          writeFileSync(
            join(evidence, `after-${lang}-no-output.png`),
            Buffer.from(shot.data, 'base64'),
          )
        }
        await read('window.__processCommand.output()')
        await wait('[data-case="inProgress"] .well')
        assert.ok(
          await read(
            `document.querySelector('[data-case="inProgress"] .well').innerText.includes("Streaming nebula")`,
          ),
        )
      }
      if (evidence) {
        const shot = await call('Page.captureScreenshot', { format: 'png' })
        writeFileSync(
          join(evidence, (baseline ? 'before' : 'after') + '-' + lang + '-expanded.png'),
          Buffer.from(shot.data, 'base64'),
        )
      }
      if (lang === 'zh-CN') await call('Page.reload')
      await wait('[data-case="inProgress"] .steps-head')
    }
    console.log(
      baseline
        ? 'BASELINE captured'
        : 'PASS process status icons, narrow ellipsis, full commands, running output',
    )
  }
} finally {
  cdp?.close()
  if (browser && browser.exitCode === null) {
    const exited = new Promise((resolve) => browser.once('exit', resolve))
    browser.kill()
    await exited
  }
  await server.close()
  rmSync(root, { recursive: true, force: true })
  if (mobileFiles) rmSync(mobileFiles, { recursive: true, force: true })
}
