import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { until } from './cdp.mjs'

export async function lifecycleProbes({ rpc, cdp, site, results, work, getReady, disconnect }) {
  async function check(name, fn) {
    try {
      results.checks.push({ name, status: 'pass', detail: await fn() })
      console.log(`PASS ${name}`)
    } catch (error) {
      results.checks.push({ name, status: 'fail', error: String(error.stack ?? error) })
      console.log(`FAIL ${name}: ${error.message}`)
    }
    writeFileSync(join(work, 'results.json'), JSON.stringify(results, null, 2))
  }
  const tab = await rpc('new', { url: site.origin })
  await rpc('attach', { tabId: tab.id })
  await until(
    () => rpc('evaluate', { tabId: tab.id, expression: '!!document.querySelector("#button")' }),
    '夹具就绪',
  )
  await check('受限 chrome 页面 debugger 限制', async () => {
    const internal = await rpc('new', { url: 'chrome://settings' })
    let platformError
    try {
      await rpc('attach', { tabId: internal.id })
    } catch (error) {
      platformError = error.message
    }
    if (!platformError) await rpc('release', { tabId: internal.id })
    await rpc('close', { tabId: internal.id })
    return {
      refusedByPlatform: !!platformError,
      platformError,
      conclusion: '产品必须自主拒绝内部URL，不能仅依赖平台',
    }
  })
  const target = (await cdp.call('Target.getTargets')).targetInfos.find(
    (item) => item.url === `${site.origin}/`,
  )
  assert(target)
  await check('DevTools 接管与 debugger detach', async () => {
    await rpc('events')
    const result = await cdp.call('Target.openDevTools', { targetId: target.targetId })
    const events = []
    const detached = await until(
      async () => {
        events.push(...(await rpc('events')))
        return events.some((event) => event.method === 'detach')
      },
      'DevTools 断开扩展调试器',
      3000,
    ).catch(() => false)
    const leaseStillActive = (await rpc('ping')).leases.includes(tab.id)
    if (detached) assert(!leaseStillActive)
    if (result.targetId) await cdp.call('Target.closeTarget', { targetId: result.targetId })
    return { result, events, detached: !!detached, leaseStillActive }
  })
  // 失败时也不遗留 DevTools，避免影响随后的 worker 探针。
  for (const item of (await cdp.call('Target.getTargets')).targetInfos) {
    if (item.url.startsWith('devtools:'))
      await cdp.call('Target.closeTarget', { targetId: item.targetId })
  }
  await check('MV3 worker 停止后由消息唤醒，不恢复旧租约', async () => {
    const wake = await cdp.call('Target.createTarget', {
      url: `chrome-extension://${results.extensionId}/wake.html`,
    })
    const { sessionId } = await cdp.call('Target.attachToTarget', {
      targetId: wake.targetId,
      flatten: true,
    })
    const versions = []
    const listener = (event) => {
      if (event.method === 'ServiceWorker.workerVersionUpdated')
        versions.push(...event.params.versions)
    }
    cdp.listeners.add(listener)
    try {
      await cdp.call('ServiceWorker.enable', {}, sessionId)
      const version = await until(
        () =>
          versions.find(
            (item) =>
              item.scriptURL === `chrome-extension://${results.extensionId}/extension.js` &&
              item.runningStatus === 'running',
          ),
        'MV3 worker version',
      )
      const before = getReady().epoch
      await cdp.call('ServiceWorker.stopWorker', { versionId: version.versionId }, sessionId)
      await cdp.call(
        'Runtime.evaluate',
        {
          expression: 'chrome.runtime.sendMessage({wake:true})',
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      )
      await until(() => getReady().epoch !== before, 'worker 重连')
      const after = await rpc('ping')
      assert.deepEqual(after.leases, [])
      return { versionId: version.versionId, before, after: after.epoch }
    } finally {
      cdp.listeners.delete(listener)
      await cdp.call('Target.detachFromTarget', { sessionId })
    }
  })
  await check('本机桥断开后扩展撤租约和调试器', async () => {
    const bridgeTab = await rpc('new', { url: site.origin })
    await rpc('attach', { tabId: bridgeTab.id })
    const worker = (await cdp.call('Target.getTargets')).targetInfos.find(
      (item) => item.url === `chrome-extension://${results.extensionId}/extension.js`,
    )
    assert(worker)
    const { sessionId } = await cdp.call('Target.attachToTarget', {
      targetId: worker.targetId,
      flatten: true,
    })
    disconnect()
    const state = await until(async () => {
      const result = await cdp.call(
        'Runtime.evaluate',
        {
          expression:
            'chrome.debugger.getTargets().then(targets=>({error:globalThis.m0NativeError,attached:targets.filter(t=>t.attached).map(t=>({type:t.type,tabId:t.tabId}))}))',
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      )
      const value = result.result.value
      return value?.error && !value.attached.some((item) => item.tabId === bridgeTab.id)
        ? value
        : null
    }, '桥断开清理')
    return state
  })
}
