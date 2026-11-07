import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { until } from '../chrome-m0/cdp.mjs'

export async function backgroundInputChecks({
  cdp,
  run,
  targetId,
  origin,
  cover,
  identity,
  shown,
  pid,
  work,
  expectFixed,
  executor,
  cases,
}) {
  const text = (result) =>
    result.contentItems
      .filter((i) => i.type === 'inputText')
      .map((i) => i.text)
      .join('\n')
  const success = async (tool, args) => {
    const result = await run(tool, args)
    assert.equal(result.success, true, text(result))
    return result
  }
  const worker = await until(
    async () =>
      (await cdp.call('Target.getTargets')).targetInfos.find(
        (t) => t.type === 'service_worker' && t.url.includes(identity.id),
      ),
    'worker',
  )
  const { sessionId: workerSession } = await cdp.call('Target.attachToTarget', {
    targetId: worker.targetId,
    flatten: true,
  })
  const extension = async (expression) =>
    (
      await cdp.call(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        workerSession,
      )
    ).result.value
  let native
  if (shown) {
    native = join(work, 'window-state')
    execFileSync('/usr/bin/xcrun', [
      'swiftc',
      fileURLToPath(new URL('./input-window.swift', import.meta.url)),
      '-o',
      native,
    ])
  }
  const observations = []
  const resize = async (windowId, left, top, width, height) => {
    await extension(`chrome.windows.update(${windowId},{state:'normal'})`)
    await until(
      async () => (await extension(`chrome.windows.get(${windowId})`)).state === 'normal',
      'normal window',
    )
    // macOS 从最小化还原后会异步恢复旧边框，待它完成再固定隔离窗口位置。
    await new Promise((resolve) => setTimeout(resolve, 400))
    await extension(
      `chrome.windows.update(${windowId},${JSON.stringify({ left, top, width, height })})`,
    )
    await until(async () => {
      const window = await extension(`chrome.windows.get(${windowId})`)
      return window.width === width && window.height === height
    }, 'fixture window dimensions')
  }
  for (const mode of [
    ...(shown ? ['foreground', 'occluded'] : []),
    'background-tab',
    'minimized',
    'no-animation-frames',
    'pointer-no-timers',
    'sign-in-return',
    'navigation',
    'frozen',
  ]) {
    if (cases && !cases.includes(mode)) continue
    const { targetId: pageTarget } = await cdp.call('Target.createTarget', {
      url: `${origin}/input`,
      newWindow: true,
      background: true,
      windowState: 'minimized',
    })
    const { sessionId } = await cdp.call('Target.attachToTarget', {
      targetId: pageTarget,
      flatten: true,
    })
    let send = (method, params) => cdp.call(method, params, sessionId)
    const read = async (expression) =>
      (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value
    await until(() => read('document.readyState === "complete"'), 'loaded input fixture')
    const tab = (await extension('chrome.tabs.query({})')).find((t) => t.url === `${origin}/input`)
    assert.ok(tab)
    await cdp.call('Target.detachFromTarget', { sessionId })
    const listing = await success('tabs', { action: 'list', targetId })
    const listed = JSON.parse(text(listing)).tabs.find(
      (t) => t.title === tab.title && t.url === tab.url,
    )
    assert.ok(listed?.claimToken, text(listing))
    const claimed = await success('claim', { claimToken: listed.claimToken })
    let tabId = JSON.parse(text(claimed).split('\n')[0]).tabId
    send = (method, params = {}) =>
      extension(
        `chrome.debugger.sendCommand({tabId:${tab.id}},${JSON.stringify(method)},${JSON.stringify(params)})`,
      )
    const { windowId } = await cdp.call('Browser.getWindowForTarget', { targetId: pageTarget })
    if (shown && ['foreground', 'background-tab', 'occluded'].includes(mode)) {
      await resize(tab.windowId, 100, 150, 800, 600)
      await extension(`chrome.tabs.update(${tab.id},{active:true})`)
      await send('Page.bringToFront')
      execFileSync(native, ['activate', String(pid)])
      if (mode === 'occluded') {
        const coverTab = (await extension('chrome.tabs.query({})')).find(
          (t) => t.windowId !== tab.windowId && t.url === 'about:blank',
        )
        await resize(coverTab.windowId, 60, 110, 1000, 800)
        await cdp.call('Target.activateTarget', { targetId: cover })
      }
    }
    if (mode === 'background-tab')
      await extension(
        `chrome.tabs.create({windowId:${tab.windowId},active:true,url:'about:blank'})`,
      )
    let pauseRefusal
    if (mode === 'sign-in-return') {
      const page = executor.pages.get(tabId)
      await page.request('freeze')
      pauseRefusal = await run('click', { tabId, x: 10, y: 10 })
      assert.equal(pauseRefusal.success, false)
      assert.match(text(pauseRefusal), /signingIn|signing in/)
      await page.request('unfreeze')
      await success('release', { tabId })
      await until(
        async () => (await extension(`chrome.tabs.get(${tab.id})`)).status === 'complete',
        'sign-in reload',
      )
      const tabs = JSON.parse(text(await success('tabs', { action: 'list', targetId }))).tabs
      tabId = JSON.parse(
        text(
          await success('claim', { claimToken: tabs.find((t) => t.url === tab.url).claimToken }),
        ).split('\n')[0],
      ).tabId
    }
    if (mode === 'navigation')
      await success('navigate', { tabId, url: `${origin}/input?new-document` })
    const snapshot = text(await success('snapshot', { tabId }))
    const ref = (name) => {
      const value = snapshot
        .split('\n')
        .find((l) => l.includes(name))
        ?.match(/\[ref=(e\d+)\]/)?.[1]
      assert.ok(value, snapshot)
      return value
    }
    const clickRef = ref('button "0"'),
      inputRef = ref('textbox "Fixture input"')
    if (mode === 'no-animation-frames') await read('window.requestAnimationFrame = () => 0')
    if (mode === 'pointer-no-timers') {
      const { frameTree } = await send('Page.getFrameTree')
      const { executionContextId } = await send('Page.createIsolatedWorld', {
        frameId: frameTree.frame.id,
        worldName: `litch-chrome-${executor.pages.get(tabId).grant.leaseId}`,
      })
      await send('Runtime.evaluate', {
        contextId: executionContextId,
        expression: 'window.requestAnimationFrame = () => 0; window.setTimeout = () => 0',
      })
    }
    if (mode === 'frozen') await send('Page.setWebLifecycleState', { state: 'frozen' })
    const state = async () => ({
      page: await read(
        '({visibility:document.visibilityState,focus:document.hasFocus(),ready:document.readyState,count:document.querySelector("#count")?.textContent,value:document.querySelector("input")?.value})',
      ),
      tab: await extension(`chrome.tabs.get(${tab.id})`),
      bounds: (await cdp.call('Browser.getWindowBounds', { windowId })).bounds,
      ...(native
        ? {
            windows: JSON.parse(
              execFileSync(native, ['observe', String(pid)], { encoding: 'utf8' }),
            ),
          }
        : {}),
    })
    const before = await state()
    if (mode === 'foreground') assert.equal(before.windows.frontmost, true)
    if (mode === 'background-tab') assert.equal(before.tab.active, false)
    if (mode === 'occluded') {
      const windows = before.windows.windows.filter((w) => w.layer === 0)
      assert.equal(windows.length, 2)
      const [front, back] = windows.map((w) => w.bounds)
      assert.ok(
        front.X <= back.X &&
          front.Y <= back.Y &&
          front.X + front.Width >= back.X + back.Width &&
          front.Y + front.Height >= back.Y + back.Height,
        JSON.stringify(windows),
      )
    }
    if (!['foreground', 'background-tab', 'occluded'].includes(mode))
      assert.equal(before.bounds.windowState, 'minimized')
    // 不重试：保留第一次点击/输入的完整回执及错误。
    const click = await run('click', { tabId, ref: clickRef })
    const typed = await run('type', { tabId, ref: inputRef, text: `value-${mode}`, clear: true })
    const after = await state()
    observations.push({ mode, before, pauseRefusal, click, typed, after })
    console.log(`CASE ${mode}: ${text(click)}\nTYPE ${text(typed)}`)
    if (expectFixed) {
      assert.equal(click.success, true, text(click))
      assert.equal(typed.success, true, text(typed))
      assert.equal(after.page.value, `value-${mode}`)
      assert.match(text(await success('snapshot', { tabId })), /button "1"/)
      assert.equal(after.tab.active, before.tab.active)
      assert.equal(after.bounds.windowState, before.bounds.windowState)
      if (before.windows) {
        assert.equal(after.windows.frontmost, before.windows.frontmost)
        assert.deepEqual(
          after.windows.windows.map((w) => w.number),
          before.windows.windows.map((w) => w.number),
        )
      }
    }
    if (mode === 'frozen') await send('Page.setWebLifecycleState', { state: 'active' })
    await success('release', { tabId })
    await extension(`chrome.windows.remove(${tab.windowId})`)
  }
  return observations
}
