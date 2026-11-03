// 隔离设备、正式核心与两端页面；--legacy 测旧完整读，--ssh 用临时回环 OpenSSH。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { Cdp, until } from './chrome-m0/cdp.mjs'
import { installManagerBoardMobileFixture } from './manager-board-mobile-fixture.mjs'
import { managerBoardUiServer } from './manager-board-ui-server.mjs'
import { managerPagingRig } from './manager-paging-rig.mjs'

const data = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const legacy = process.argv.includes('--legacy')
const ssh = process.argv.includes('--ssh')
const mobile = process.argv.includes('--mobile')
data.paging = !legacy
const repo = resolve(import.meta.dirname, '..')
const { env, owner } = managerPagingRig(data)
const server = createServer()
const sockets = new WebSocketServer({ server })
const calls = []
let failMethod = null
owner.tree.host.announce = (method, params) => {
  for (const socket of sockets.clients) socket.send(JSON.stringify({ method, params }))
}
sockets.on('connection', (socket) =>
  socket.on('message', async (raw) => {
    const { id, method, params } = JSON.parse(String(raw))
    const start = performance.now()
    try {
      if (method === failMethod) {
        failMethod = null
        throw new Error('隔离测试：分页读取失败')
      }
      const result = await owner.call(method, params, true, !legacy)
      const text = JSON.stringify({ id, result })
      calls.push({ method, bytes: Buffer.byteLength(text), ms: performance.now() - start })
      socket.send(text)
    } catch (error) {
      socket.send(JSON.stringify({ id, error: String(error) }))
    }
  }),
)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
let port = server.address().port
let tunnel, ui, browser, cdp
const root = mkdtempSync(join(tmpdir(), 'manager-paging-ui-'))
try {
  if (ssh) {
    tunnel = spawn(
      process.execPath,
      [join(repo, 'scripts/bench-manager-board-transport.mjs'), '--forward', String(port)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let text = ''
    tunnel.stdout.on('data', (chunk) => {
      text += chunk
    })
    tunnel.stderr.on('data', (chunk) => process.stderr.write(chunk))
    port = await until(
      () => {
        try {
          return JSON.parse(text.trim()).port
        } catch {
          return null
        }
      },
      'SSH 转发',
      30000,
    )
  }
  ui = mobile
    ? await installManagerBoardMobileFixture()
    : await managerBoardUiServer(repo, port, port)
  data.rpcUrl = mobile ? `ws://127.0.0.1:${port}` : `${ui.url.replace('http:', 'ws:')}/fixture-rpc`
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
  browser = spawn(
    binary,
    [
      '--headless=new',
      `--user-data-dir=${root}/profile`,
      '--remote-debugging-port=0',
      '--use-mock-keychain',
      '--password-store=basic',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    {
      env: { HOME: root, PATH: '/usr/bin:/bin', TMPDIR: root },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let output = ''
  browser.stderr.on('data', (chunk) => {
    output += chunk
  })
  cdp = await Cdp.connect(
    await until(() => output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], '浏览器'),
  )
  const target = (await cdp.call('Target.getTargets')).targetInfos.find((t) => t.type === 'page')
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const call = (method, params) => cdp.call(method, params, sessionId)
  await call('Page.enable')
  await call('Runtime.enable')
  const firstSelector = mobile
    ? `[data-testid="${legacy ? 'manager-issue:D-20' : 'paging-object:D-20'}"]`
    : legacy
      ? '[data-decision="D-20"]'
      : '[data-paging-object="D-20"]'
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `const observer=new MutationObserver(()=>{const state=window.__managerBoardFixture;if(!state?.deliveredAt||!document.querySelector(${JSON.stringify(firstSelector)}))return;observer.disconnect();requestAnimationFrame(()=>requestAnimationFrame(()=>{window.__managerFirstFrame=performance.now()-state.deliveredAt}));});observer.observe(document,{childList:true,subtree:true});`,
  })
  const read = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const errors = []
  cdp.listeners.add((frame) => {
    if (frame.method === 'Runtime.exceptionThrown') errors.push(frame.params.exceptionDetails)
    if (frame.method === 'Fetch.requestPaused')
      void call('Fetch.fulfillRequest', {
        requestId: frame.params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(data)).toString('base64'),
      })
  })
  await call('Fetch.enable', { patterns: [{ urlPattern: '*__manager_board_data*' }] })
  await call('Emulation.setDeviceMetricsOverride', {
    width: mobile ? 412 : 1440,
    height: mobile ? 915 : 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  const wait = (selector) =>
    until(() => read(`!!document.querySelector(${JSON.stringify(selector)})`), selector, 60000)
  const click = async (selector) => {
    await wait(selector)
    await read(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  const samplesMs = []
  for (let round = 0; round < 3; round++) {
    await call('Page.navigate', {
      url: mobile
        ? `${ui.url}/?app=1&scene=manager-console&lang=zh-CN&skin=standard&appearance=light`
        : `${ui.url}/test/manager-board-fixture.html?onboarding=off`,
    })
    if (!mobile) {
      await wait('[data-sidebar-mode="manager"]')
      await read(
        'document.querySelector(\'[data-act="onboard-close"]\')?.click();window.__litchLook.set({skin:"standard",theme:"light",lang:"zh-CN"})',
      )
      await click('[data-sidebar-mode="manager"]')
      await click('[data-manager-id="m1"] .mg-pick')
    }
    await wait(firstSelector)
    samplesMs.push(await until(() => read('window.__managerFirstFrame'), '首帧'))
  }
  const bootstrapCalls = [...calls]
  writeFileSync(
    `/tmp/manager-paging-${mobile ? 'mobile' : 'desktop'}-${legacy ? 'legacy' : 'paged'}-${ssh ? 'ssh' : 'local'}-first.png`,
    Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  )
  if (!legacy) {
    assert.ok(!calls.some((call) => call.method === 'litch/manager/board/read'))
    assert.ok(
      !calls.some(
        (call) =>
          call.method === 'litch/manager/object/read' ||
          call.method === 'litch/manager/object/history',
      ),
    )
    const filter = (status) =>
      mobile ? `[data-testid="paging-filter:${status}"]` : `[data-paging-filter="${status}"]`
    const objects = mobile ? '[data-testid^="paging-object:"]' : '[data-paging-object]'
    await click(filter('answered'))
    await until(() => read(`document.querySelectorAll('${objects}').length===30`), '已答复第一页')
    await click(mobile ? '[data-testid="paging-more"]' : '[data-paging-more]')
    await until(() => read(`document.querySelectorAll('${objects}').length===40`), '已答复第二页')
    await read(
      `(()=>{const e=document.querySelector('${mobile ? '[data-testid="manager-board-scroll"]' : '.mg-body'}');window.__pagingScroller=e;e.scrollTop=500;})()`,
    )
    await until(() => read('window.__pagingScroller.scrollTop>400'), '滚动至列表中部')
    // RN Web 的 scrollend 在 100ms 后回传末尾位置；先等模拟滚动进入组件再切页。
    await new Promise((resolve) => setTimeout(resolve, 150))
    await click(filter('open'))
    await wait(firstSelector)
    await click(filter('answered'))
    await until(() => read('window.__pagingScroller.scrollTop>400'), '恢复筛选页滚动位置')
    await click(filter('open'))
    await wait(firstSelector)
    await click(firstSelector + (mobile ? '' : ' button'))
    const detail = mobile ? '[data-testid="manager-issue:D-20"]' : '[data-decision="D-20"]'
    await wait(detail)
    if (!mobile)
      assert.equal(
        await read('document.querySelectorAll("[data-manager-paging] [data-filter]").length'),
        0,
        '详情不显示局部缓存计数的旧筛选条',
      )
    assert.equal(
      calls.some((call) => call.method === 'litch/manager/object/history'),
      false,
    )
    failMethod = 'litch/manager/object/history'
    await click(mobile ? '[data-testid="paging-history"]' : '[data-paging-history]')
    await until(
      () => read('document.body.textContent.includes("隔离测试：分页读取失败")'),
      '历史失败可见',
    )
    await click(mobile ? '[data-testid="paging-history"]' : '[data-paging-history]')
    await until(
      () => calls.some((call) => call.method === 'litch/manager/object/history'),
      '历史按需读取',
    )
    await read(
      `(()=>{const e=document.querySelector('${detail} textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'隔离分页验收');e.dispatchEvent(new Event('input',{bubbles:true}));window.__managerBoardFixture.fail=true})()`,
    )
    const submit = mobile ? '[data-testid="decision-submit:D-20"]' : '[data-act="manager-submit"]'
    await until(() => read(`!document.querySelector('${submit}').disabled`), '允许答复')
    await click(submit)
    await until(() => read('document.body.textContent.includes("隔离测试：提交失败")'), '失败提示')
    assert.ok(await read(`!!document.querySelector(${JSON.stringify(firstSelector)})`))
    await read('window.__managerBoardFixture.fail=false')
    await click(submit)
    await until(
      () => read(`!document.querySelector(${JSON.stringify(firstSelector)})`),
      '成功移出待定',
    )
    await click(filter('answered'))
    await until(
      () => read(`document.querySelectorAll('${objects}').length===41`),
      '已加载页对账保留范围',
    )
    const answerCalls = calls.slice(calls.findIndex((call) => call.method.endsWith('/submit')))
    assert.equal(
      answerCalls.filter((call) => call.method === 'litch/manager/board/summary').length,
      1,
      '答复只需一次后台对账',
    )
    owner.writer.tool(data.manager.id, 'add', {
      kind: 'request',
      revision: 0,
      why: '隔离验收',
      request: { title: '分页请求', description: '仅检查详情按需加载' },
    })
    owner.posts.tool(data.manager.id, 'report', {
      title: '分页报告',
      body: '仅检查报告已阅',
      why: '隔离验收',
    })
    const item = owner.writer.object(data.manager.id, 'I-100')
    owner.store.saveObject(data.manager.id, { ...item, status: 'done' })
    owner.tree.store.addProposal({
      id: 'paging-closed',
      threadId: data.manager.threadId,
      title: '分页已取消建议',
      prompt: '已了结建议按需详情',
      harness: null,
      model: null,
      cwd: null,
      kind: 'fresh',
      wakeParent: false,
      createdAt: 1800000000,
      expiresAt: 9999999999,
    })
    owner.tree.store.settleProposal('paging-closed', 'dismissed', null)
    owner.changed(data.manager.id)
    const objectSelector = (id) =>
      mobile ? `[data-testid="paging-object:${id}"]` : `[data-paging-object="${id}"]`
    for (const [category, id] of [
      ['request', 'R-1'],
      ['report', 'P-1'],
    ]) {
      await click(
        mobile ? `[data-testid="manager-category:${category}"]` : `[data-board-tab="${category}s"]`,
      )
      await click(objectSelector(id) + (mobile ? '' : ' button'))
      await wait(
        mobile
          ? `[data-testid="manager-issue:${id}"]`
          : category === 'request'
            ? `[data-manager-request="${id}"]`
            : `[data-report="${id}"]`,
      )
    }
    await click(mobile ? '[data-testid="report-read:P-1"]' : '[data-act="report-read"]')
    await until(() => read(`!document.querySelector('${objectSelector('P-1')}')`), '已阅移出未阅页')
    await click(filter('read'))
    await wait(objectSelector('P-1'))
    await click(
      mobile ? '[data-testid="manager-category:suggestion"]' : '[data-board-tab="suggestions"]',
    )
    await click(filter('dismissed'))
    await click(objectSelector('S-paging-closed') + (mobile ? '' : ' button'))
    await wait(
      mobile ? '[data-testid="manager-issue:S-paging-closed"]' : '[data-proposal="paging-closed"]',
    )
    if (mobile) {
      await click('[data-testid="manager-tab:overview"]')
      await click('[data-testid="paging-items"]')
    } else await click('[data-board-tab="items"]')
    await until(() => read(`document.querySelectorAll('${objects}').length===30`), '事项第一页')
    if (mobile) await click('[data-testid="paging-order:oldest"]')
    else
      await read(
        '(()=>{const e=document.querySelector("[data-act=manager-issue-order]");e.value="oldest";e.dispatchEvent(new Event("change",{bubbles:true}))})()',
      )
    await until(
      () =>
        read(
          `document.querySelector('${objects}')?.getAttribute('${mobile ? 'data-testid' : 'data-paging-object'}')==='${mobile ? 'paging-object:' : ''}I-1'`,
        ),
      '事项最早排序',
    )
    await click(filter('done'))
    await click(objectSelector('I-100') + (mobile ? '' : ' button'))
    await wait(mobile ? '[data-testid="overview-item:I-100"]' : '[data-manager-item="I-100"]')
    if (mobile) {
      await click('[data-testid="manager-tab:chat"]')
      await click('a[href="litch-issue:D-15"]')
      await wait('[data-testid="issue-sheet:D-15"]')
    } else {
      await read(
        'window.dispatchEvent(new CustomEvent("litch-manager-issue",{detail:{managerId:"m1",id:"D-60"}}))',
      )
      await wait('[data-decision="D-60"]')
    }
  }
  const image = `/tmp/manager-paging-${mobile ? 'mobile' : 'desktop'}-${legacy ? 'legacy' : 'paged'}-${ssh ? 'ssh' : 'local'}.png`
  writeFileSync(
    image,
    Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  )
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify({
      mobile,
      legacy,
      ssh,
      samplesMs,
      medianMs: [...samplesMs].sort((a, b) => a - b)[1],
      bootstrapCalls,
      calls,
      image,
    }),
  )
} finally {
  cdp?.close()
  if (browser) {
    browser.kill()
    if (browser.exitCode === null) await new Promise((r) => browser.once('exit', r))
  }
  await ui?.close()
  if (tunnel) {
    tunnel.kill()
    if (tunnel.exitCode === null) await new Promise((r) => tunnel.once('exit', r))
  }
  for (const socket of sockets.clients) socket.terminate()
  await new Promise((r) => sockets.close(r))
  await new Promise((r) => server.close(r))
  await env.close()
  rmSync(root, { recursive: true, force: true })
}
