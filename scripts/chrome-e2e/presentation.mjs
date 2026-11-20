// 只在隔离扩展 worker 记录 API 调用；业务操作走正式执行器和原生桥。
import assert from 'node:assert/strict'
import { setTimeout as pause } from 'node:timers/promises'
import { until } from '../chrome-m0/cdp.mjs'

export async function chromePresentation({
  cdp,
  identity,
  bridge,
  targetId,
  origin,
  success,
  text,
  measure,
}) {
  const worker = (await cdp.call('Target.getTargets')).targetInfos.find(
    (target) =>
      target.type === 'service_worker' &&
      target.url.startsWith(`chrome-extension://${identity.id}/`),
  )
  assert.ok(worker, '隔离扩展 worker')
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: worker.targetId,
    flatten: true,
  })
  const inspect = async (expression) => {
    const reply = await cdp.call(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    )
    assert.equal(reply.exceptionDetails, undefined, JSON.stringify(reply.exceptionDetails))
    return reply.result.value
  }
  const url = `${origin}/presentation`
  let native
  try {
    native = await inspect(`(async () => {
      const tab = await chrome.tabs.create({url:${JSON.stringify(url)}, active:false})
      const events = globalThis.presentationEvents = []
      const group = chrome.tabGroups
      for (const [name, api, key] of [
        ['group',group,'update'], ['badge',chrome.action,'setBadgeText'],
        ['badgeColor',chrome.action,'setBadgeBackgroundColor'], ['icon',chrome.action,'setIcon'],
        ['title',chrome.action,'setTitle'],
      ]) {
        const original = api[key].bind(api)
        api[key] = (...args) => {
          const [first, second] = args
          if (name === 'group' || first.tabId === tab.id)
            events.push({at:performance.now(),name,value: name === 'group' ? second.color : first.text})
          return original(...args)
        }
      }
      return tab.id
    })()`)
    const state = () =>
      inspect(`(async()=>{
      const tab=await chrome.tabs.get(${native});
      return {groupId:tab.groupId,color:tab.groupId<0?null:(await chrome.tabGroups.get(tab.groupId)).color,
        badge:await chrome.action.getBadgeText({tabId:tab.id}),status:tab.status};
    })()`)
    await until(async () => (await state()).status === 'complete', '隔离标签加载')
    const claim = async () =>
      JSON.parse(text(await success('ensure_claimed', { targetId, url })).split('\n')[0]).tabId
    let tabId = await claim()
    const before = await inspect('presentationEvents.length')
    const started = performance.now()
    for (let n = 0; n < 3; n++) {
      const snapshot = text(await success('snapshot', { tabId }))
      const button = snapshot.match(new RegExp(`button "${n}".*?\\[ref=([^\\]\\s]+)\\]`))?.[1]
      const input = snapshot.match(/textbox "Fixture input".*?\[ref=([^\]\s]+)\]/)?.[1]
      assert.ok(button && input, snapshot)
      await success('click', { tabId, ref: button })
      await success('type', { tabId, ref: input, text: `isolated-${n}`, clear: true })
    }
    assert.match(text(await success('snapshot', { tabId })), /button "3"[\s\S]*isolated-2/)
    const elapsedMs = Math.round(performance.now() - started)
    const events = await inspect('presentationEvents')
    const operations = events.slice(before)
    const summary = {
      elapsedMs,
      totals: Object.fromEntries(
        ['group', 'badge', 'badgeColor', 'icon', 'title'].map((name) => [
          name,
          operations.filter((event) => event.name === name).length,
        ]),
      ),
      groupColors: operations
        .filter((event) => event.name === 'group')
        .slice(0, 8)
        .map((event) => event.value),
      badgeText: operations
        .filter((event) => event.name === 'badge')
        .slice(0, 8)
        .map((event) => event.value),
    }
    console.log(`CHROME_PRESENTATION ${JSON.stringify(summary)}`)
    if (!measure) {
      assert.deepEqual(operations, [], '命令与期间的对账不应重涂')
      assert.deepEqual(
        events.filter((event) => event.name === 'group').map((event) => event.value),
        ['orange'],
      )
      assert.deepEqual(
        events.filter((event) => event.name === 'badge').map((event) => event.value),
        ['AI'],
      )
      await pause(2800)
      assert.equal((await state()).color, 'orange', '有效租约跨空闲仍亮')
      assert.equal((await state()).badge, 'AI')
      assert.equal(await inspect('presentationEvents.length'), events.length)
      await success('navigate', { tabId, url: `${origin}/presentation-next` })
      await until(async () => (await state()).badge === 'AI', '导航后租约徽标')
      assert.equal((await state()).color, 'orange')
      const afterNavigation = await inspect('presentationEvents')
      assert.deepEqual(
        afterNavigation.filter((event) => event.name === 'group').map((event) => event.value),
        ['orange'],
      )
      summary.navigationBadgeWrites =
        afterNavigation.filter((event) => event.name === 'badge').length - 1
      assert.ok(summary.navigationBadgeWrites <= 1)
      await success('navigate', { tabId, url })
    }
    await success('release', { tabId })
    const restored = async () => {
      const current = await state()
      return current.groupId === -1 && current.badge !== 'AI'
    }
    assert.ok(await restored(), '交还应答时已复原')
    if (!measure) {
      assert.deepEqual(
        (await inspect('presentationEvents'))
          .filter((event) => event.name === 'badge')
          .slice(-1)
          .map((event) => event.value),
        [null],
      )
      tabId = await claim()
      assert.equal((await state()).badge, 'AI')
      const disconnectedAt = performance.now()
      await bridge.close()
      await until(restored, '断线后清除分组和徽标', 2200)
      summary.disconnectRestoreMs = Math.round(performance.now() - disconnectedAt)
      await bridge.start()
      await until(() => bridge.instances().length === 1, '隔离桥重新握手')
      await claim()
      const wake = await cdp.call('Target.createTarget', {
        url: `chrome-extension://${identity.id}/test-wake.html`,
      })
      try {
        const { sessionId: stopSession } = await cdp.call('Target.attachToTarget', {
          targetId: wake.targetId,
          flatten: true,
        })
        const result = await cdp.call(
          'Runtime.evaluate',
          {
            expression: "chrome.runtime.sendMessage({type:'stop'})",
            awaitPromise: true,
            returnByValue: true,
          },
          stopSession,
        )
        assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails))
        assert.deepEqual(result.result.value, { ok: true })
        assert.ok(await restored(), '停止应答时已复原')
        assert.equal((await state()).badge, 'OFF', '逐标签徽标不应盖住全局停止状态')
      } finally {
        await cdp.call('Target.closeTarget', { targetId: wake.targetId })
      }
    }
    return summary
  } finally {
    if (native !== undefined) await inspect(`chrome.tabs.remove(${native})`).catch(() => {})
    await cdp.call('Target.detachFromTarget', { sessionId })
  }
}
