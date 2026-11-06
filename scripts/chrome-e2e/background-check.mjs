// 仅操作本次隔离 CFT：两个 headed 窗口，记录每个工具前后的焦点和中途激活事件。
import assert from 'node:assert/strict'
import { until } from '../chrome-m0/cdp.mjs'

export async function backgroundChecks({
  cdp,
  send,
  targetId,
  origin,
  check,
  waitSignIn,
  foreground,
}) {
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
    // 两个窗口都最小化。参考窗口仅有 Chrome 内部活动标签，不请求 macOS 前台。
    first = await evaluate(
      `chrome.windows.create({url:${JSON.stringify(fixtureUrl)},type:'normal',focused:false,state:'minimized'})`,
    )
    await evaluate(`chrome.windows.update(${first.id},{state:'minimized'})`)
    // 参考活动标签只在测试 Chrome 内部切换，代理页面保持后台；不激活系统窗口。
    await evaluate(`chrome.tabs.create({windowId:${first.id},url:'about:blank',active:true})`)
    const tabId = await checkAndClaim(first.tabs[0].id)
    front = await evaluate(
      `chrome.windows.create({url:'about:blank',type:'normal',focused:false,state:'minimized'})`,
    )
    await evaluate(`chrome.windows.update(${front.id},{state:'minimized'})`)
    await until(
      () =>
        evaluate(
          `chrome.windows.getAll({windowTypes:['normal']}).then(windows=>windows.every(window=>window.state==='minimized'))`,
        ),
      'two minimized Chrome windows',
    )
    await foreground.check('two minimized Chrome windows created')
    assert.ok((await active()).windows.every((window) => !window.focused))
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
      await foreground.check('background window action')
      const windows = await evaluate('chrome.windows.getAll({windowTypes:["normal"]})')
      assert.ok(
        windows.every((window) => window.state === 'minimized'),
        `all Chrome windows remain minimized: ${JSON.stringify(windows.map((window) => ({ id: window.id, state: window.state, focused: window.focused })))}`,
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
      '双后台窗口：navigate/newTab/claim/click/type/run_actions 不改变参考窗口或活动标签',
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
    // show 的语义就是激活系统窗口，不能在无打扰验收中执行该对照。
    await check('后台重新认领不激活窗口或切换活动标签', async () => {
      await checkAndClaim(first.tabs[0].id)
      await verify()
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
