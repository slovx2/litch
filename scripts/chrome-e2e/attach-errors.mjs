// 只操作本次隔离 CFT：商店域名由启动参数阻断，普通网页只访问回环夹具。
import assert from 'node:assert/strict'

export async function chromeAttachErrors({
  cdp,
  identity,
  call,
  text,
  targetId,
  site,
  check,
  until,
}) {
  const evidence = []
  for (const [url, reason] of [
    ['chrome://version/', /internal Chrome/],
    [`chrome-extension://${identity.id}/test-wake.html`, /extension page/],
    ['https://chromewebstore.google.com/detail/isolated-fixture', /Chrome Web Store/],
    ['https://chrome.google.com/webstore/detail/isolated-fixture', /Chrome Web Store/],
  ]) {
    const target = await cdp.call('Target.createTarget', { url, background: true })
    try {
      await check(`受限页认领返回准确原因：${url}`, async () => {
        const tab = await until(async () => {
          const listed = await call('tabs', { action: 'list', targetId })
          assert.equal(listed.success, true, text(listed))
          return JSON.parse(text(listed)).tabs.find((tab) => tab.url === url)
        }, 'Restricted tab listed')
        assert.match(tab.unavailableReason, reason)
        const result = await call('claim', { claimToken: tab.claimToken })
        assert.equal(result.success, false)
        const failure = JSON.parse(text(result))
        assert.equal(failure.code, 'targetUnavailable')
        assert.match(failure.message, reason)
        assert.match(failure.message, /Open a new regular HTTP\(S\) tab/)
        assert.doesNotMatch(failure.message, /Close.*DevTools/)
        evidence.push({ url, code: failure.code, message: failure.message })
      })
    } finally {
      await cdp.call('Target.closeTarget', { targetId: target.targetId })
    }
  }
  await check('拒绝受限页面后可新开回环网页，导航不更换实例 targetId', async () => {
    const result = await call('navigate', { targetId, url: site.origin, newTab: true })
    assert.equal(result.success, true, text(result))
    const { tabId } = JSON.parse(text(result))
    const snapshot = await call('snapshot', { tabId })
    assert.equal(snapshot.success, true, text(snapshot))
    const next = await call('navigate', { tabId, url: `${site.origin}/?next=1` })
    assert.equal(next.success, true, text(next))
    const listed = await call('targets', {})
    assert.equal(listed.success, true, text(listed))
    assert.ok(JSON.parse(text(listed)).targets.some((target) => target.targetId === targetId))
    await call('tabs', { action: 'close', tabId })
  })
  return evidence
}
