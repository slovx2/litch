// 两个模拟会话经正式扩展/桥交接；原生锁本体由 Swift 无输入测试覆盖。
import assert from 'node:assert/strict'
import { until } from '../chrome-m0/cdp.mjs'

export async function chromeHandoff({
  executor,
  targetId,
  origin,
  invocation,
  context,
  check,
  cdp,
  identity,
}) {
  let seq = 0
  const text = (result) =>
    result.contentItems
      .filter((item) => item.type === 'inputText')
      .map((item) => item.text)
      .join('\n')
  const run = (session, tool, args) =>
    executor.call(
      {
        ...invocation,
        threadId: `handoff-${session}`,
        turnId: `handoff-turn-${session}`,
        sessionTitle: `交接验收 ${session}`,
        callId: `handoff-${++seq}`,
        tool,
        arguments: args,
      },
      context,
    )
  const success = async (session, tool, args) => {
    const result = await run(session, tool, args)
    assert.equal(result.success, true, text(result))
    return text(result)
  }
  const claim = async (session, url) =>
    JSON.parse((await success(session, 'ensure_claimed', { targetId, url })).split('\n')[0]).tabId
  const aUrl = `${origin}/handoff-a`
  const a = JSON.parse(
    (await success('a', 'navigate', { targetId, url: aUrl, keep: true })).split('\n')[0],
  ).tabId
  const native = executor.pages.get(a).grant.tabId
  await check('交接：未释放报会话标题，另一会话仍可新开并操作自己的标签', async () => {
    const blocked = await run('b', 'ensure_claimed', { targetId, url: aUrl })
    assert.equal(blocked.success, false)
    assert.match(text(blocked), /交接验收 a/)
    assert.match(text(blocked), /release\(tabId\)/)
    const b = JSON.parse(
      (await success('b', 'navigate', { targetId, url: `${origin}/input`, keep: true })).split(
        '\n',
      )[0],
    ).tabId
    await success('b', 'snapshot', { tabId: b })
    await success('b', 'release', { tabId: b })
  })
  await check('交接：A 释放后 B 立即认领同一真实标签，旧 A 不能操作', async () => {
    await success('a', 'release', { tabId: a })
    const b = await claim('b', aUrl)
    assert.equal(executor.pages.get(b).grant.tabId, native)
    assert.equal((await run('a', 'snapshot', { tabId: a })).success, false)
    await success('b', 'release', { tabId: b })
  })
  await check('交接：A 回合结束后 B 可认领，旧回合不能重取', async () => {
    const next = await claim('a', aUrl)
    executor.turnEnded({ deviceId: 'local', threadId: 'handoff-a', turnId: 'handoff-turn-a' })
    await until(() => !executor.pages.get(next).valid, 'ended turn releases lease')
    const b = await claim('b', aUrl)
    assert.equal((await run('a', 'ensure_claimed', { targetId, url: aUrl })).success, false)
    await success('b', 'release', { tabId: b })
  })
  // 只诊断现场双指针线索，不把尚未证实的修法混入交接改动。
  const pointer = {}
  await check('指针诊断：移动视口、外部撤调试器、重新认领后的 DOM 数量', async () => {
    const url = `${origin}/handoff-pointer`
    let pageId = JSON.parse(
      (await success('c', 'navigate', { targetId, url, keep: true })).split('\n')[0],
    ).tabId
    const nativeTab = executor.pages.get(pageId).grant.tabId
    const targets = (await cdp.call('Target.getTargets')).targetInfos
    const pageTarget = targets.find((target) => target.type === 'page' && target.url === url)
    const inspect = async (resize = false) => {
      const { sessionId } = await cdp.call('Target.attachToTarget', {
        targetId: pageTarget.targetId,
        flatten: true,
      })
      try {
        if (resize)
          await cdp.call(
            'Emulation.setDeviceMetricsOverride',
            { width: 375, height: 667, deviceScaleFactor: 2, mobile: true },
            sessionId,
          )
        const value = await cdp.call(
          'Runtime.evaluate',
          {
            expression: "document.querySelectorAll('[data-litch-chrome-pointer]').length",
            returnByValue: true,
          },
          sessionId,
        )
        return value.result.value
      } finally {
        await cdp.call('Target.detachFromTarget', { sessionId })
      }
    }
    await inspect(true)
    await success('c', 'snapshot', { tabId: pageId })
    await success('c', 'click', { tabId: pageId, x: 40, y: 40 })
    pointer.before = await inspect()
    assert.equal(pointer.before, 1)
    const worker = targets.find(
      (target) =>
        target.type === 'service_worker' &&
        target.url.startsWith(`chrome-extension://${identity.id}/`),
    )
    const { sessionId } = await cdp.call('Target.attachToTarget', {
      targetId: worker.targetId,
      flatten: true,
    })
    try {
      await cdp.call(
        'Runtime.evaluate',
        { expression: `chrome.debugger.detach({tabId:${nativeTab}})`, awaitPromise: true },
        sessionId,
      )
    } finally {
      await cdp.call('Target.detachFromTarget', { sessionId })
    }
    // debugger.detach 的主动调用不发 onDetach；模拟调试通道已经消失后执行正常交还。
    await success('c', 'release', { tabId: pageId })
    pointer.afterDetach = await inspect()
    pageId = await claim('d', url)
    await success('d', 'click', { tabId: pageId, x: 40, y: 240 })
    pointer.afterReclaim = await inspect()
    assert.equal(pointer.afterReclaim, 1)
    await success('d', 'release', { tabId: pageId })
    pointer.afterRelease = await inspect()
    assert.equal(pointer.afterRelease, 0)
    // 不发 release 模拟外部断线：页面中的到期器独立清理，不需要重连调试器。
    pageId = await claim('e', url)
    await success('e', 'click', { tabId: pageId, x: 40, y: 200 })
    assert.equal(await inspect(), 1)
    const workerSession = await cdp.call('Target.attachToTarget', {
      targetId: worker.targetId,
      flatten: true,
    })
    const disconnectedAt = Date.now()
    try {
      await cdp.call(
        'Runtime.evaluate',
        { expression: `chrome.debugger.detach({tabId:${nativeTab}})`, awaitPromise: true },
        workerSession.sessionId,
      )
    } finally {
      await cdp.call('Target.detachFromTarget', { sessionId: workerSession.sessionId })
    }
    await until(async () => (await inspect()) === 0, 'disconnected pointer expires', 5000)
    pointer.expiryMs = Date.now() - disconnectedAt
    assert.ok(pointer.expiryMs <= 3000, JSON.stringify(pointer))
    await success('e', 'release', { tabId: pageId })
    console.log(`POINTER_HANDOFF_EVIDENCE ${JSON.stringify(pointer)}`)
  })
  const nativeTabs = [
    ...new Set(
      [...executor.pages.values()]
        .filter((page) => page.grant.owner.threadId.startsWith('handoff-'))
        .map((page) => page.grant.tabId),
    ),
  ]
  const worker = (await cdp.call('Target.getTargets')).targetInfos.find(
    (target) =>
      target.type === 'service_worker' &&
      target.url.startsWith(`chrome-extension://${identity.id}/`),
  )
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: worker.targetId,
    flatten: true,
  })
  try {
    await cdp.call(
      'Runtime.evaluate',
      { expression: `chrome.tabs.remove(${JSON.stringify(nativeTabs)})`, awaitPromise: true },
      sessionId,
    )
  } finally {
    await cdp.call('Target.detachFromTarget', { sessionId })
  }
  return { pointer }
}
