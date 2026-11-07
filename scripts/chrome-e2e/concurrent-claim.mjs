// 真实双扩展并发 claim：共享原生文件锁必须保证只有一个宿主取得标签。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export async function concurrentClaim({ cdp, first, second, firstId, origin, invocation, until }) {
  const worker = async (id) => {
    const target = (await cdp.call('Target.getTargets')).targetInfos.find(
      (target) =>
        target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${id}/`),
    )
    assert.ok(target)
    return (await cdp.call('Target.attachToTarget', { targetId: target.targetId, flatten: true }))
      .sessionId
  }
  const sessions = [await worker(firstId), await worker(second.id)]
  const evaluate = (sessionId, expression) =>
    cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  const url = `${origin}/simultaneous-claim?run=${randomUUID()}`
  const target = await cdp.call('Target.createTarget', { url })
  await until(
    async () =>
      (
        await evaluate(
          sessions[0],
          `chrome.tabs.query({}).then(tabs => tabs.some(tab => tab.url === ${JSON.stringify(url)} && tab.status === 'complete'))`,
        )
      ).result?.value,
    'Race fixture document loaded',
  )
  let seq = 0
  const session = `simultaneous-claim-${randomUUID()}`
  const context = { signal: new AbortController().signal, ask: async () => 'once' }
  const invoke = (executor, tool, args) =>
    executor.call(
      {
        ...invocation,
        namespace: executor.namespace,
        callId: `race-${++seq}`,
        threadId: session,
        turnId: 'race-turn',
        tool,
        arguments: args,
      },
      context,
    )
  const text = (result) =>
    result.contentItems
      .filter((item) => item.type === 'inputText')
      .map((item) => item.text)
      .join('\n')
  const token = async (executor, targetId) => {
    const listed = await invoke(executor, 'tabs', { action: 'list', targetId })
    assert.equal(listed.success, true, text(listed))
    return JSON.parse(text(listed)).tabs.find((tab) => tab.url === url)?.claimToken
  }
  const targets = [first, second.executor]
  const targetIds = [first.pages.values().next().value?.instanceId, second.bridge.instances()[0].id]
  assert.ok(targetIds[0])
  const tokens = await Promise.all(
    targets.map((executor, i) =>
      until(() => token(executor, `chrome:${targetIds[i]}`), 'Race tab listed'),
    ),
  )
  try {
    // 两个宿主先拿到同一空闲目标的真实身份，再并发走原生 claim；锁失败必须在扩展 attach 前返回。
    const before = await Promise.all(
      sessions.map((sessionId) => evaluate(sessionId, 'chrome.debugger.getTargets()')),
    )
    const attempts = targets.map((executor, i) =>
      invoke(executor, 'claim', { claimToken: tokens[i] }),
    )
    const results = await Promise.all(attempts)
    const after = await Promise.all(
      sessions.map((sessionId) => evaluate(sessionId, 'chrome.debugger.getTargets()')),
    )
    const report = {
      outcomes: results.map((result) => ({ success: result.success, result: text(result) })),
      before: before.map((result) => result.result?.value?.filter((tab) => tab.url === url)),
      after: after.map((result) => result.result?.value?.filter((tab) => tab.url === url)),
      bothSucceeded: results.every((result) => result.success),
      nativeBusy: results.some(
        (result) => !result.success && text(result).includes('native host claim lock'),
      ),
    }
    assert.equal(report.before[0]?.length, 1)
    assert.equal(report.before[1]?.length, 1)
    assert.equal(report.before[0][0].id, report.before[1][0].id)
    assert.equal(report.before[0][0].attached, false)
    assert.equal(report.before[1][0].attached, false)
    for (let i = 0; i < results.length; i++)
      if (results[i].success)
        await invoke(targets[i], 'release', { tabId: JSON.parse(text(results[i])).tabId })
    return report
  } finally {
    await cdp.call('Target.closeTarget', { targetId: target.targetId })
  }
}
