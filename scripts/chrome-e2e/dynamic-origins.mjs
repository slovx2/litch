import assert from 'node:assert/strict'
import { until } from '../chrome-m0/cdp.mjs'

/** 在正式 MV3/桥路径中，认领之后才由输入事件动态加载第二来源。 */
export async function dynamicOriginChecks({ executor, targetId, site, invocation, check }) {
  let sequence = 0
  const text = (result) =>
    result.contentItems
      .filter((item) => item.type === 'inputText')
      .map((item) => item.text)
      .join('\n')
  for (const mode of ['trustAll', 'approval', 'blocked', 'decline'])
    await check(`动态 iframe：${mode} 按当前网站许可处理`, async () => {
      const owner = { ...invocation, threadId: `dynamic-${mode}`, turnId: `dynamic-turn-${mode}` }
      const asks = []
      const context = {
        signal: new AbortController().signal,
        ask: async (request) => {
          asks.push(request)
          return mode === 'decline' && request.origin === site.other ? 'decline' : 'once'
        },
      }
      const call = (tool, args) =>
        executor.call({ ...owner, callId: `dynamic-${++sequence}`, tool, arguments: args }, context)
      const success = async (tool, args) => {
        const result = await call(tool, args)
        assert.equal(result.success, true, text(result))
        return result
      }
      executor.sites.setTrustAll(mode === 'trustAll' || mode === 'blocked')
      if (mode === 'blocked') executor.sites.block('b.test')
      try {
        const tabId = JSON.parse(
          text(await success('navigate', { targetId, url: `${site.origin}/dynamic-frames` })).split(
            '\n',
          )[0],
        ).tabId
        const before = text(await success('snapshot', { tabId }))
        assert.doesNotMatch(before, /DYNAMIC_EDITOR_CONTENT/)
        const ref = before.match(/button "Add editor".*?\[ref=([^\]\s]+)\]/)?.[1]
        assert.ok(ref, before)
        const clicked = await success('click', { tabId, ref })
        await until(
          () =>
            site.requests.filter((path) => path === '/dynamic-frame-content').length >=
            ['trustAll', 'approval', 'blocked', 'decline'].indexOf(mode) + 1,
          '动态 iframe 已载入',
        )
        if (mode === 'trustAll' || mode === 'approval')
          await success('wait', { tabId, for: 'text', text: 'DYNAMIC_EDITOR_CONTENT' })
        const result = await call('snapshot', { tabId })
        const page = executor.pages.get(tabId)
        if (mode === 'blocked' || mode === 'decline') {
          assert.equal(result.success, false)
          assert.match(text(result), mode === 'blocked' ? /blocked/ : /declin/)
          assert.doesNotMatch(text(result) + text(clicked), /DYNAMIC_EDITOR_CONTENT/)
          assert.ok(!page.grant.origins.includes(site.other))
          const shot = await call('screenshot', { tabId })
          assert.equal(shot.success, false)
          assert.ok(
            shot.contentItems.every((item) => item.type !== 'inputImage'),
            '未批准来源不能通过截图泄漏',
          )
        } else {
          assert.equal(result.success, true, text(result))
          assert.match(text(result), /DYNAMIC_EDITOR_CONTENT/)
          assert.ok(page.grant.origins.includes(site.other))
        }
        const frameAsks = asks.filter(
          (request) => request.kind === 'site' && request.origin === site.other,
        )
        assert.equal(frameAsks.length, mode === 'approval' || mode === 'decline' ? 1 : 0)
        await success('release', { tabId })
      } finally {
        executor.turnEnded({
          deviceId: owner.device.id,
          threadId: owner.threadId,
          turnId: owner.turnId,
        })
        executor.sites.unblock()
        executor.sites.setTrustAll(false)
      }
    })
}
