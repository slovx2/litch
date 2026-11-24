// foreground-steal.mjs 的步骤：三种窗口条件 × 常用工具，每步只记录变化，不重试、不恢复焦点。
import assert from 'node:assert/strict'
import { until } from '../chrome-m0/cdp.mjs'

const text = (result) =>
  result.contentItems
    .filter((item) => item.type === 'inputText')
    .map((item) => item.text)
    .join('\n')
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** 页面自己开新页面后，系统前台必须在这段时间内还回原应用。 */
const RESTORE_LIMIT_MS = 600

export async function foregroundSteps({
  cdp,
  run,
  bridge,
  identity,
  origin,
  pid,
  foreground,
  windowOrder,
  restore,
  prime,
  only,
}) {
  const worker = await until(
    async () =>
      (await cdp.call('Target.getTargets')).targetInfos.find(
        (target) => target.type === 'service_worker' && target.url.includes(identity.id),
      ),
    'extension worker',
  )
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: worker.targetId,
    flatten: true,
  })
  const extension = async (expression) =>
    (
      await cdp.call(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      )
    ).result.value
  const chromeAbove = (snapshot) => {
    const chrome = snapshot.order.indexOf(pid)
    const front = snapshot.order.indexOf(snapshot.frontmost)
    return chrome >= 0 && front >= 0 && chrome < front
  }
  const chromeState = () =>
    extension(`chrome.windows.getAll({populate:true,windowTypes:['normal']}).then(ws=>ws.map(w=>({
      id:w.id,focused:w.focused,state:w.state,active:w.tabs.filter(t=>t.active).map(t=>t.id)})))`)
  // worker 刚起来时扩展 API 可能还没绑定；先等它就绪，否则注入的监听会静默失败。
  await until(() => extension("typeof chrome.tabs?.onCreated === 'object'"), 'extension APIs')
  await extension(`globalThis.__fg=[];
    chrome.tabs.onActivated.addListener(t=>__fg.push({activated:t.tabId,window:t.windowId}));
    chrome.windows.onFocusChanged.addListener(w=>{if(w>=0)__fg.push({focused:w})});
    chrome.tabs.onCreated.addListener(t=>__fg.push({tab:t.id,opener:t.openerTabId,active:t.active}));
    chrome.windows.onCreated.addListener(w=>__fg.push({created:w.id,state:w.state,createdFocused:w.focused}))`)
  const report = []
  let scenario = ''
  const step = async (name, work) => {
    const before = { order: windowOrder(), chrome: await chromeState() }
    await extension('__fg.length=0')
    await foreground.mark()
    let value, error
    try {
      value = await work()
    } catch (caught) {
      error = String(caught?.stack ?? caught)
    }
    // 激活与交还都是异步的：留出时间再取样。
    const pageOpened = scenario === 'page-initiated'
    await settle(pageOpened ? 1000 : 400)
    const stolen = await foreground.mark()
    const after = { order: windowOrder(), chrome: await chromeState() }
    const events = await extension('__fg.splice(0)')
    const problems = []
    if (error) problems.push(`error: ${error.split('\n')[0]}`)
    if (pageOpened) {
      // 页面自己开新页面：Chrome 内部切到新标签是页面语义；系统前台必须很快还回原应用。
      if (stolen.pids.length && !stolen.back) problems.push('macOS frontmost was not restored')
      const longest = Math.max(0, ...stolen.away)
      if (longest > RESTORE_LIMIT_MS)
        problems.push(`macOS frontmost was away for ${longest} ms (limit ${RESTORE_LIMIT_MS})`)
    } else if (stolen.pids.length)
      problems.push(`macOS frontmost changed to pid ${stolen.pids.join(',')}`)
    if (!chromeAbove(before.order) && chromeAbove(after.order))
      problems.push('a Chrome window was ordered above the frontmost application')
    if (after.chrome.some((window) => window.focused)) problems.push('a Chrome window is focused')
    const focusEvents = events.filter((event) => event.focused !== undefined)
    if (focusEvents.length && !pageOpened)
      problems.push(`windows.onFocusChanged ${JSON.stringify(focusEvents)}`)
    for (const window of before.chrome) {
      const now = after.chrome.find((one) => one.id === window.id)
      if (now && !pageOpened && JSON.stringify(now.active) !== JSON.stringify(window.active))
        problems.push(`active tab of window ${window.id} changed`)
      if (now && window.state === 'minimized' && now.state !== 'minimized')
        problems.push(`window ${window.id} was restored from minimized`)
    }
    const entry = {
      scenario,
      step: name,
      problems,
      away: stolen.away,
      events,
      chrome: after.chrome,
    }
    report.push(entry)
    const away = stolen.away.length ? ` (frontmost away ${stolen.away.join(',')} ms)` : ''
    console.log(
      `${problems.length ? 'STEAL' : 'OK   '} ${scenario} / ${name}${away} ${problems.join('; ')}`,
    )
    if (error) throw Error(`${scenario} / ${name}: ${error}`)
    if (stolen.pids.length || windowOrder().frontmost !== foreground.baseline.pid) await restore()
    return value
  }
  const success = async (tool, args) => {
    const result = await run(tool, args)
    assert.equal(result.success, true, text(result))
    return text(result)
  }
  const refs = (snapshot) => ({
    button: snapshot.match(/button "\d+".*?\[ref=([^\]\s]+)\]/)?.[1],
    input: snapshot.match(/textbox "Fixture input".*?\[ref=([^\]\s]+)\]/)?.[1],
  })
  const closeAllPages = async () => {
    for (const target of (await cdp.call('Target.getTargets')).targetInfos)
      if (target.type === 'page')
        await cdp.call('Target.closeTarget', { targetId: target.targetId })
    await until(async () => (await chromeState()).length === 0, 'no Chrome windows')
  }
  const exercise = async (tabId) => {
    const snapshot = await step('snapshot', () => success('snapshot', { tabId }))
    const { button, input } = refs(snapshot)
    assert.ok(button && input, snapshot)
    await step('screenshot', () => success('screenshot', { tabId }))
    await step('click', () => success('click', { tabId, ref: button }))
    await step('type', () => success('type', { tabId, ref: input, text: 'fixture' }))
    await step('press', () => success('press', { tabId, key: 'Tab' }))
    await step('scroll', () => success('scroll', { tabId, dy: 120, x: 20, y: 20 }))
    await step('evaluate', () => success('evaluate', { tabId, expression: 'document.title' }))
    const fresh = refs(await success('snapshot', { tabId }))
    await step('run_actions', () =>
      success('run_actions', {
        actions: [
          { tool: 'click', arguments: { tabId, ref: fresh.button } },
          { tool: 'type', arguments: { tabId, ref: fresh.input, text: 'batch', clear: true } },
          { tool: 'press', arguments: { tabId, key: 'Enter' } },
        ],
      }),
    )
  }
  const opened = (value) => JSON.parse(value.split('\n')[0]).tabId

  // 启动后用 CDP 在后台建一个普通窗口，代表用户自己开着、但不在前台的 Chrome。
  scenario = 'setup'
  await step('user window (harness, not product)', async () => {
    const { targetId } = await cdp.call('Target.createTarget', {
      url: `${origin}/input?user`,
      newWindow: true,
      background: true,
    })
    const { windowId } = await cdp.call('Browser.getWindowForTarget', { targetId })
    await cdp.call('Browser.setWindowBounds', {
      windowId,
      bounds: { left: 160, top: 140, width: 900, height: 700 },
    })
  })
  // macOS 14 起的协作式激活：从没被用户激活过的应用请求激活会被系统拒绝。日用 Chrome 是用户用过的，
  // 这里先把隔离 CFT 激活一次再还回原应用，模拟“用户刚从 Chrome 切到别的应用”。
  await prime()
  await until(() => bridge.instances().length === 1, 'native bridge')
  const targetId = `chrome:${bridge.instances()[0].id}`

  const want = (name) => !only || only.includes(name)
  const claimUrl = async (url) => {
    const listing = await step('tabs list', () => success('tabs', { action: 'list', targetId }))
    const user = JSON.parse(listing).tabs.find((tab) => tab.url === url)
    assert.ok(user?.claimToken, listing)
    return JSON.parse(
      (await step('claim', () => success('claim', { claimToken: user.claimToken }))).split('\n')[0],
    ).tabId
  }

  // 页面自己开新页面或请求聚焦：由模型点击触发，CDP 合成输入带用户激活。
  if (want('page')) {
    scenario = 'page-initiated'
    const { targetId: page } = await cdp.call('Target.createTarget', {
      url: `${origin}/foreground`,
      background: true,
    })
    await until(
      async () =>
        (await extension('chrome.tabs.query({})')).some(
          (tab) => tab.url === `${origin}/foreground` && tab.status === 'complete',
        ),
      'foreground fixture',
    )
    const tabId = await claimUrl(`${origin}/foreground`)
    const triggers = [
      ['link target=_blank', /link "Blank link".*?\[ref=([^\]\s]+)\]/],
      ['window.open tab', /button "Open tab".*?\[ref=([^\]\s]+)\]/],
      ['window.open popup', /button "Open popup window".*?\[ref=([^\]\s]+)\]/],
      ['window.focus()', /button "Focus window".*?\[ref=([^\]\s]+)\]/],
    ]
    for (const [name, pattern] of triggers) {
      const ref = (await success('snapshot', { tabId })).match(pattern)?.[1]
      assert.ok(ref, name)
      await step(`click → ${name}`, () => success('click', { tabId, ref }))
      for (const target of (await cdp.call('Target.getTargets')).targetInfos)
        if (target.type === 'page' && /blank-link|window-open|popup-window/.test(target.url))
          await cdp.call('Target.closeTarget', { targetId: target.targetId })
    }
    await step('release', () => success('release', { tabId }))
    await cdp.call('Target.closeTarget', { targetId: page })
  }

  if (want('show')) {
    // 正对照：show 本来就要把窗口拿到前台，用来确认监视器能看到抢前台。
    scenario = 'positive control'
    const tabId = await claimUrl(`${origin}/input?user`)
    await step('show (expected to activate)', () => success('show', { tabId }))
    await step('release', () => success('release', { tabId }))
  }

  if (!want('tools')) return report
  scenario = 'visible window'
  const userTab = await claimUrl(`${origin}/input?user`)
  await exercise(userTab)
  await step('navigate same tab', () =>
    success('navigate', { tabId: userTab, url: `${origin}/input?navigated` }),
  )
  await step('history back', () => success('navigate', { tabId: userTab, action: 'back' }))
  const newTab = opened(
    await step('navigate newTab', () =>
      success('navigate', { targetId, newTab: true, url: `${origin}/input?new` }),
    ),
  )
  await exercise(newTab)
  const blank = opened(await step('tabs new', () => success('tabs', { action: 'new', targetId })))
  await step('tabs close (agent tab)', () => success('tabs', { action: 'close', tabId: blank }))
  await step('release new tab', () => success('release', { tabId: newTab }))
  await step('release user tab', () => success('release', { tabId: userTab }))

  scenario = 'no window'
  await closeAllPages()
  const lone = opened(
    await step('navigate newTab (creates window)', () =>
      success('navigate', { targetId, newTab: true, url: `${origin}/input?lone` }),
    ),
  )
  await exercise(lone)
  await step('release', () => success('release', { tabId: lone }))

  scenario = 'minimized window'
  await closeAllPages()
  await cdp.call('Target.createTarget', {
    url: `${origin}/input?minimized-user`,
    newWindow: true,
    background: true,
    windowState: 'minimized',
  })
  await until(
    async () => (await chromeState()).some((window) => window.state === 'minimized'),
    'minimized window',
  )
  const tucked = opened(
    await step('navigate newTab', () =>
      success('navigate', { targetId, newTab: true, url: `${origin}/input?tucked` }),
    ),
  )
  await exercise(tucked)
  await step('release', () => success('release', { tabId: tucked }))
  return report
}
