// 用正式工具调用核对派发、导航、SPA 和批量回执；断言页面变化，不把 success 当业务成功。
import assert from 'node:assert/strict'

export async function inputChecks({ run, targetId, origin, check }) {
  const text = (result) =>
    result.contentItems
      .filter((item) => item.type === 'inputText')
      .map((item) => item.text)
      .join('\n')
  const receipt = (result) =>
    result.contentItems.flatMap((item) => {
      if (item.type !== 'inputText') return []
      try {
        return [JSON.parse(item.text).inputReceipt].filter(Boolean)
      } catch {
        return []
      }
    })[0]
  const success = async (tool, args) => {
    const result = await run(tool, args)
    assert.equal(result.success, true, text(result))
    return result
  }
  const opened = await success('navigate', { targetId, url: `${origin}/input` })
  const tabId = JSON.parse(text(opened).split('\n')[0]).tabId
  const ref = async (role, name) => {
    const snapshot = text(await success('snapshot', { tabId }))
    const found = snapshot
      .split('\n')
      .find((line) => line.includes(`${role} "${name}"`))
      ?.match(/\[ref=([^\]\s]+)\]/)?.[1]
    assert.ok(found, snapshot)
    return found
  }
  try {
    await check('ensure_claimed 一次恢复同一标签并返回新代次快照', async () => {
      const first = await success('ensure_claimed', { tabId })
      const oldRef = /\[ref=([^\]]+)\]/.exec(text(first))[1]
      await success('release', { tabId })
      const fresh = await success('ensure_claimed', { tabId })
      assert.equal(JSON.parse(fresh.contentItems[0].text).tabId, tabId)
      const stale = await run('click', { tabId, ref: oldRef })
      assert.equal(stale.success, false)
      assert.equal(receipt(stale).mayHaveExecuted, false)
      assert.equal(receipt(stale).recovery.needs_snapshot, true)
    })
    await check('已知操作与业务等待合为一次批量调用', async () => {
      const button = await ref('button', '0')
      const result = await success('run_actions', {
        actions: [
          { tool: 'click', arguments: { tabId, ref: button } },
          { tool: 'wait', arguments: { tabId, for: 'text', text: '1', timeoutMs: 2000 } },
        ],
      })
      assert.equal(JSON.parse(result.contentItems[0].text).verification.status, 'matched')
      await success('navigate', { tabId, url: `${origin}/input` })
    })
    await check('大页面默认压缩且完整快照、分页、紧凑 diff 可恢复', async () => {
      await success('evaluate', {
        tabId,
        expression: `document.body.innerHTML = Array.from({length:500}, (_,i) => '<div><button>Fixture settings row '+i+' with a useful accessible name for permissions</button></div>').join('')`,
      })
      const compact = text(await success('snapshot', { tabId }))
      const full = text(await success('snapshot', { tabId, detail: 'full' }))
      assert.ok(compact.length < full.length / 3)
      assert.match(full, /Fixture settings row 499/)
      const metadata = JSON.parse(
        compact.split('\n').find((l) => l.startsWith('{"observation":')),
      ).observation
      assert.match(
        text(await success('snapshot', { tabId, offset: metadata.next_offset, detail: 'full' })),
        /Fixture settings row 499/,
      )
      await success('snapshot', { tabId, detail: 'full' })
      await success('evaluate', {
        tabId,
        expression: "document.querySelector('button').textContent = 'Saved fixture'",
      })
      const diff = text(await success('snapshot', { tabId, diff: true }))
      assert.match(diff, /Saved fixture/)
      assert.ok(diff.length < full.length / 10)
      console.log(
        'FRICTION_SIZE ' +
          JSON.stringify({
            browser: 'chrome',
            full: full.length,
            compact: compact.length,
            diff: diff.length,
          }),
      )
      await success('navigate', { tabId, url: `${origin}/input` })
    })
    await check('后台点击和输入：回执记录派发与实际焦点/字段变化', async () => {
      const clicked = await success('click', { tabId, ref: await ref('button', '0') })
      assert.equal(receipt(clicked)?.dispatch, 'dispatched')
      assert.equal(receipt(clicked)?.observation, 'changed')
      assert.equal(receipt(clicked)?.businessOutcome, 'unknown')
      assert.match(text(await success('snapshot', { tabId })), /button "1"/)
      const typed = await success('type', {
        tabId,
        ref: await ref('textbox', 'Fixture input'),
        text: 'SPA fixture',
        clear: true,
      })
      assert.equal(receipt(typed)?.after.focus.value, 'SPA fixture')
      const pressed = await success('press', { tabId, key: 'Tab' })
      assert.equal(receipt(pressed)?.dispatch, 'dispatched')
      assert.ok(receipt(pressed)?.changes.includes('focus'))
    })
    await check('点击跳转恢复当前文档观察，不返回 staleDocument、不泄露签名参数', async () => {
      const result = await success('click', { tabId, ref: await ref('link', 'Navigate fixture') })
      assert.equal(receipt(result)?.navigation, true, text(result))
      assert.equal(receipt(result)?.destination, `${origin}/input-next`)
      assert.doesNotMatch(
        text(result),
        /fixture-private-signature|fixture-secret-fragment|fixture-otp-secret/,
      )
      assert.ok(receipt(result)?.after)
      await success('snapshot', { tabId })
    })
    await check('SPA 延迟提交有界观察，业务结果仍未知；可按 URL 和确认文案显式等待', async () => {
      const result = await success('click', { tabId, ref: await ref('button', 'Save SPA') })
      assert.equal(receipt(result)?.navigation, true)
      assert.equal(receipt(result)?.businessOutcome, 'unknown')
      assert.ok(receipt(result)?.elapsedMs < 7000)
      await success('wait', { tabId, for: 'url', url: '/input-spa', timeoutMs: 2000 })
      await success('wait', { tabId, for: 'text', text: 'Saved fixture', timeoutMs: 2000 })
    })
    await check('批量中途失败保留已派发步骤，明确首个失败位置与最终观察状态', async () => {
      const result = await run('run_actions', {
        actions: [
          {
            tool: 'type',
            arguments: {
              tabId,
              ref: await ref('textbox', 'Fixture input'),
              text: 'batch value',
              clear: true,
            },
          },
          { tool: 'click', arguments: { tabId, ref: 'e-does-not-exist' } },
          { tool: 'press', arguments: { tabId, key: 'Enter' } },
        ],
      })
      assert.equal(result.success, false)
      const value = JSON.parse(result.contentItems[0].text)
      assert.equal(value.completed, 1)
      assert.equal(value.firstFailedStep, 2)
      assert.equal(value.steps.length, 2)
      assert.equal(value.steps[0].dispatch, 'dispatched')
      assert.equal(value.steps[1].mayHaveExecuted, false)
      assert.equal(value.actionsStatus, 'stopped')
      assert.equal(value.observationStatus, 'completed')
      assert.match(text(result), /batch value/)
    })
    await check('同值输入允许无变化，回执不宣称业务成功', async () => {
      const input = await ref('textbox', 'Fixture input')
      await success('type', { tabId, ref: input, text: 'unchanged', clear: true })
      const result = await success('type', { tabId, ref: input, text: 'unchanged', clear: true })
      assert.equal(receipt(result)?.observation, 'unchanged')
      assert.equal(receipt(result)?.businessOutcome, 'unknown')
    })
    await check('输入跨来源跳转仅回派发和目标地址，未授权页面内容仍不可读', async () => {
      const result = await success('click', {
        tabId,
        ref: await ref('link', 'Cross origin fixture'),
      })
      assert.equal(receipt(result)?.navigation, true)
      assert.equal(receipt(result)?.after, null)
      assert.equal(receipt(result)?.observation, 'unavailable')
      assert.doesNotMatch(text(result), /UNAPPROVED_CONTENT_MUST_NOT_LEAK/)
      const snapshot = await run('snapshot', { tabId })
      assert.equal(snapshot.success, false)
      assert.match(text(snapshot), /originNotApproved/)
    })
  } finally {
    await run('tabs', { tabId, action: 'close' })
  }
}
