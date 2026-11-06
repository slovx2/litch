// 仅操作本次隔离 CFT：两个 headed 窗口，记录每个工具前后的焦点和中途激活事件。
import assert from 'node:assert/strict'
import { until } from '../chrome-m0/cdp.mjs'

export async function backgroundChecks({ cdp, send, targetId, origin, check, waitSignIn }) {
  const fixtureUrl = `${origin}/input?background-window-fixture`
  const worker = (await cdp.call('Target.getTargets')).targetInfos.find(
    (t) => t.type === 'service_worker',
  )
  assert.ok(worker)
  const { sessionId } = await cdp.call('Target.attachToTarget', {
    targetId: worker.targetId,
    flatten: true,
  })
  const evaluate = async (expression) => {
    const value = await cdp.call(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    )
    assert.equal(value.exceptionDetails, undefined, JSON.stringify(value.exceptionDetails))
    return value.result.value
  }
  const text = (result) =>
    result.contentItems
      .filter((i) => i.type === 'inputText')
      .map((i) => i.text)
      .join('\n')
  const run = async (tool, args) => {
    const result = (await send({ op: 'invoke', tool, args })).result
    assert.equal(result.success, true, text(result))
    return text(result)
  }
  const active = () =>
    evaluate(
      `(async()=>({windows:(await chrome.windows.getAll({windowTypes:['normal']})).map(w=>({id:w.id,focused:w.focused})).sort((a,b)=>a.id-b.id),tabs:(await chrome.tabs.query({active:true})).map(t=>({id:t.id,windowId:t.windowId})).sort((a,b)=>a.id-b.id)}))()`,
    )
  let first, front
  try {
    // 已授权前台验收时段中的隔离窗口；不访问、移动或激活用户真实 Chrome。
    first = await evaluate(
      `chrome.windows.create({url:${JSON.stringify(fixtureUrl)},type:'normal',focused:false,left:0,top:0,width:640,height:480})`,
    )
    const tabId = await checkAndClaim(first.tabs[0].id)
    front = await evaluate(
      `chrome.windows.create({url:'about:blank',type:'normal',focused:true,left:40,top:40,width:640,height:480})`,
    )
    await until(
      async () => (await active()).windows.find((w) => w.id === front.id)?.focused,
      'isolated foreground window',
    )
    await evaluate(
      `globalThis.__litchFocusEvents=[];globalThis.__litchActivated=t=>__litchFocusEvents.push({tab:t.tabId,window:t.windowId});globalThis.__litchFocused=w=>{if(w>=0)__litchFocusEvents.push({window:w})};chrome.tabs.onActivated.addListener(__litchActivated);chrome.windows.onFocusChanged.addListener(__litchFocused)`,
    )
    const baseline = await active()
    const verify = async () => {
      assert.deepEqual(
        await active(),
        baseline,
        'foreground window and active tabs must not change',
      )
      assert.deepEqual(
        await evaluate('__litchFocusEvents'),
        [],
        'no transient tab/window activation',
      )
    }
    const ref = async (role, name) => {
      const snapshot = await run('snapshot', { tabId })
      const value = snapshot
        .split('\n')
        .find((line) => line.includes(`${role} "${name}"`))
        ?.match(/\[ref=(e\d+)\]/)?.[1]
      assert.ok(value, snapshot)
      return value
    }
    await check(
      '非活动窗口：navigate/newTab/claim/click/type/run_actions 均不改变前台或活动标签',
      async () => {
        await run('navigate', { tabId, url: fixtureUrl })
        await verify()
        const opened = JSON.parse(
          (await run('navigate', { targetId, newTab: true, url: `${origin}/input` })).split(
            '\n',
          )[0],
        )
        await verify()
        await run('click', { tabId, ref: await ref('button', '0') })
        await verify()
        await run('type', {
          tabId,
          ref: await ref('textbox', 'Fixture input'),
          text: 'background fixture',
        })
        await verify()
        await run('run_actions', {
          actions: [
            {
              tool: 'type',
              arguments: {
                tabId,
                ref: await ref('textbox', 'Fixture input'),
                text: 'batch background',
                clear: true,
              },
            },
            { tool: 'press', arguments: { tabId, key: 'Tab' } },
          ],
        })
        await verify()
        assert.match(await run('snapshot', { tabId }), /batch background/)
        await run('tabs', { action: 'close', tabId: opened.tabId })
        await verify()
      },
    )
    await check('登录卡等待期间不激活后台标签或窗口', async () => {
      const pending = send({
        op: 'invoke',
        tool: 'request_sign_in',
        args: { tabId, reason: 'Isolated focus test' },
        delay: 1500,
      })
      await waitSignIn()
      await verify()
      const result = (await pending).result
      assert.equal(result.success, true, text(result))
      await verify()
    })
    // 重新认领发生在前台窗口已经建立之后，也纳入事件断言。
    const reclaimed = await checkAndClaim(first.tabs[0].id)
    await verify()
    await check('只有显式 show 才激活指定标签与窗口', async () => {
      await run('show', { tabId: reclaimed })
      await until(
        async () => (await active()).windows.find((w) => w.id === first.id)?.focused,
        'explicit show',
      )
      assert.ok((await active()).tabs.some((t) => t.id === first.tabs[0].id))
    })
  } finally {
    await evaluate(
      `if(globalThis.__litchActivated)chrome.tabs.onActivated.removeListener(__litchActivated);if(globalThis.__litchFocused)chrome.windows.onFocusChanged.removeListener(__litchFocused)`,
    ).catch(() => {})
    for (const window of [first, front])
      if (window) await evaluate(`chrome.windows.remove(${window.id})`).catch(() => {})
    await cdp.call('Target.detachFromTarget', { sessionId }).catch(() => {})
  }
  async function checkAndClaim(id) {
    await until(
      () => evaluate(`chrome.tabs.get(${id}).then(t=>t.status==='complete')`),
      'isolated fixture loaded',
    )
    const listing = await until(async () => {
      const tabs = JSON.parse(await run('tabs', { action: 'list', targetId })).tabs
      return tabs.find((tab) => tab.url === fixtureUrl)
    }, 'isolated tab listing')
    assert.ok(listing?.claimToken, JSON.stringify(listing))
    return JSON.parse(await run('claim', { claimToken: listing.claimToken })).tabId
  }
}
