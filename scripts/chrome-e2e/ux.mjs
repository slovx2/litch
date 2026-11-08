// 只在隔离 CFT 中通过扩展 API 布置/观察用户标签；业务动作仍走正式 executor。
import assert from 'node:assert/strict'
import { until } from '../chrome-m0/cdp.mjs'

export async function chromeUx({
  check,
  cdp,
  workerSession,
  executor,
  targetId,
  site,
  invocation,
  context,
}) {
  const owner = {
    ...invocation,
    threadId: 'chrome-ux',
    turnId: 'chrome-ux-turn',
    sessionTitle: '标签分组与批量验收',
  }
  let sequence = 0
  const text = (result) =>
    result.contentItems
      .filter((item) => item.type === 'inputText')
      .map((item) => item.text)
      .join('\n')
  const call = (tool, args, ctx = context) =>
    executor.call({ ...owner, callId: `ux-${++sequence}`, tool, arguments: args }, ctx)
  const success = async (tool, args) => {
    const result = await call(tool, args)
    assert.equal(result.success, true, text(result))
    return text(result)
  }
  const inspect = async (expression) => {
    const sessionId = await workerSession()
    try {
      const reply = await cdp.call(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      )
      assert.equal(reply.exceptionDetails, undefined, JSON.stringify(reply.exceptionDetails))
      return reply.result.value
    } finally {
      await cdp.call('Target.detachFromTarget', { sessionId }).catch(() => {})
    }
  }
  const state = (id) =>
    inspect(
      `(async()=>{const tab=await chrome.tabs.get(${id});return {tab,group:tab.groupId<0?null:await chrome.tabGroups.get(tab.groupId),badge:await chrome.action.getBadgeText({tabId:${id}})}})()`,
    )
  const claim = async (native) => {
    await until(async () => (await state(native)).tab.status === 'complete', 'UX tab loaded')
    const list = JSON.parse(await success('tabs', { action: 'list', targetId })).tabs
    const url = (await state(native)).tab.url
    return JSON.parse(
      await success('claim', { claimToken: list.find((tab) => tab.url === url).claimToken }),
    ).tabId
  }
  let user, peer, claimed, original
  await check('按会话归组 / 用户原组和顺序恢复 / 固定标签恢复', async () => {
    const setup = await inspect(`(async()=>{
      const a=await chrome.tabs.create({url:${JSON.stringify(`${site.origin}/ux-user`)},active:false});
      const b=await chrome.tabs.create({url:${JSON.stringify(`${site.origin}/ux-peer`)},active:false});
      const id=await chrome.tabs.group({tabIds:[a.id,b.id]});
      await chrome.tabGroups.update(id,{title:'用户资料',color:'purple',collapsed:true});
      return {a:await chrome.tabs.get(a.id),b:await chrome.tabs.get(b.id),group:id}
    })()`)
    user = setup.a.id
    peer = setup.b.id
    original = setup
    claimed = await claim(user)
    const agent = JSON.parse(
      (await success('navigate', { targetId, url: `${site.origin}/ux-agent`, keep: true })).split(
        '\n',
      )[0],
    ).tabId
    const agentNative = executor.pages.get(agent).grant.tabId
    assert.equal((await state(user)).tab.groupId, (await state(agentNative)).tab.groupId)
    assert.match((await state(user)).group.title, /标签分组与批量验收/)
    assert.equal((await state(peer)).tab.groupId, original.group)
    await success('release', { tabId: claimed })
    const restored = await state(user)
    assert.equal(restored.tab.groupId, original.group)
    assert.equal(restored.tab.index, original.a.index)
    assert.equal(restored.group.title, '用户资料')
    assert.equal(restored.group.collapsed, true)
    assert.equal(restored.badge, '')
    await success('release', { tabId: agent })
    assert.equal((await state(agentNative)).tab.groupId, -1)
    const pinned = await inspect(
      `chrome.tabs.create({url:${JSON.stringify(`${site.origin}/ux-pinned`)},active:false,pinned:true})`,
    )
    const pinLease = await claim(pinned.id)
    assert.equal((await state(pinned.id)).tab.pinned, false)
    await success('release', { tabId: pinLease })
    assert.equal((await state(pinned.id)).tab.pinned, true)
    await inspect(`chrome.tabs.remove([${agentNative},${pinned.id}])`)
    claimed = await claim(user)
  })
  await check('活动组颜色和逐标签 AI 徽标 / 异常后复原 / 不改 favicon', async () => {
    const before = (await state(user)).tab.favIconUrl
    const pending = call('evaluate', {
      tabId: claimed,
      expression: 'new Promise(resolve=>setTimeout(()=>resolve(1),1000))',
    })
    await until(async () => (await state(user)).badge === 'AI', 'AI badge during operation')
    assert.equal((await state(user)).group.color, 'orange')
    assert.equal((await pending).success, true)
    await until(async () => (await state(user)).badge === '', 'AI badge cleared')
    assert.equal((await state(user)).group.color, 'blue')
    assert.equal((await state(user)).tab.favIconUrl, before)
    assert.equal((await call('click', { tabId: claimed, ref: 'e999999' })).success, false)
    assert.equal((await state(user)).badge, '')
  })
  await check('Chrome 批量正常执行 / 中途失败 / 最后快照 / callId 不重放', async () => {
    const snapshot = await success('snapshot', { tabId: claimed })
    const ref = snapshot.match(/button "0".*?\[ref=([^\]\s]+)\]/)?.[1]
    assert.ok(ref, snapshot)
    const batch = {
      ...owner,
      callId: 'ux-repeat',
      tool: 'run_actions',
      arguments: {
        actions: [
          { tool: 'click', arguments: { tabId: claimed, ref } },
          { tool: 'click', arguments: { tabId: claimed, ref } },
        ],
      },
    }
    const first = await executor.call(batch, context)
    assert.equal(first.success, true, text(first))
    assert.match(text(first), /Final snapshot:[\s\S]*button "2"/)
    assert.deepEqual(await executor.call(batch, context), first)
    const next = text(first).match(/button "2".*?\[ref=([^\]\s]+)\]/)?.[1]
    const failed = await call('run_actions', {
      actions: [
        { tool: 'click', arguments: { tabId: claimed, ref: next } },
        { tool: 'click', arguments: { tabId: claimed, ref: 'e999999' } },
        { tool: 'click', arguments: { tabId: claimed, ref: next } },
      ],
    })
    assert.equal(failed.success, false)
    assert.match(text(failed), /"completed":1/)
    assert.match(text(failed), /Final snapshot:[\s\S]*button "3"/)
  })
  await check('批量逐步来源审批 / 拒绝后不执行余下步骤', async () => {
    let approvals = 0
    const ctx = {
      ...context,
      ask: async (ask) => {
        if (ask.kind === 'site') {
          approvals++
          return 'decline'
        }
        return 'once'
      },
    }
    const result = await call(
      'run_actions',
      {
        actions: [
          { tool: 'navigate', arguments: { tabId: claimed, url: `${site.other}/ux-declined` } },
          { tool: 'navigate', arguments: { tabId: claimed, url: `${site.origin}/must-not-load` } },
        ],
      },
      ctx,
    )
    assert.equal(result.success, false)
    assert.equal(approvals, 1)
    assert.equal((await state(user)).tab.url, `${site.origin}/ux-user`)
    assert.equal(site.requests.includes('/must-not-load'), false)
  })
  await check('Chrome 批量跨文档禁止后续键盘输入', async () => {
    await success('snapshot', { tabId: claimed })
    const result = await call('run_actions', {
      actions: [
        { tool: 'navigate', arguments: { tabId: claimed, url: `${site.origin}/ux-next` } },
        { tool: 'press', arguments: { tabId: claimed, key: 'Enter' } },
      ],
    })
    assert.equal(result.success, false)
    assert.match(text(result), /"completed":1/)
    assert.match(text(result), /document changed/)
    assert.match(text(result), /Final snapshot:/)
    await success('navigate', { tabId: claimed, url: `${site.origin}/ux-user` })
  })
  await check('批量中途撤租约即停 / 回合结束恢复用户组并关闭临时标签', async () => {
    const temporary = JSON.parse(
      (await success('navigate', { targetId, url: `${site.origin}/ux-temp` })).split('\n')[0],
    ).tabId
    const nativeTemp = executor.pages.get(temporary).grant.tabId
    const pending = call('run_actions', {
      actions: [
        { tool: 'wait', arguments: { tabId: claimed, for: 'time', ms: 500 } },
        { tool: 'press', arguments: { tabId: claimed, key: 'Enter' } },
      ],
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    executor.turnEnded({
      deviceId: owner.device.id,
      threadId: owner.threadId,
      turnId: owner.turnId,
    })
    const result = await pending
    assert.equal(result.success, false)
    assert.match(text(result), /"completed":0/)
    await until(
      async () => (await state(user)).tab.groupId === original.group,
      'Original group restored at turn end',
    )
    assert.equal(await inspect(`chrome.tabs.get(${nativeTemp}).then(()=>false,()=>true)`), true)
    assert.equal((await state(user)).badge, '')
    await inspect(`chrome.tabs.remove([${user},${peer}])`)
  })
}
