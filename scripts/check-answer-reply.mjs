// 复用隔离搜索验收的浏览器与真实 Transcript，不另起窗口、不保存图片。
import assert from 'node:assert/strict'
import { until } from './chrome-m0/cdp.mjs'

export async function checkAnswerReply({ cdp, evaluate, query, report, base }) {
  await cdp.call('Page.navigate', { url: base + '/test/search-fixture.html?lang=zh-CN' })
  await until(
    () => evaluate('!!window.searchFixture && !!document.querySelector(".tr")'),
    '问答夹具',
  )
  for (const mode of ['adjacent', 'peer-first', 'reply-first', 'previous-turn']) {
    await evaluate('window.searchFixture.answerReplyScene(' + JSON.stringify(mode) + ')')
    await until(() => evaluate('!!document.querySelector(".ask")'), '问题卡')
    const expected = mode === 'adjacent' ? 0 : 1
    await until(
      () => evaluate('document.querySelectorAll(".ask-reply").length === ' + expected),
      '答复位置',
    )
    if (expected) {
      assert.equal(
        await evaluate('document.querySelector(".ask-reply-a").textContent'),
        'AnswerPositionNeedle',
      )
      assert.ok(await evaluate('!!document.querySelector("[data-peer]")'))
      const order = await evaluate(
        'Array.from(document.querySelectorAll("[data-peer],.ask-reply")).map(el => el.hasAttribute("data-peer") ? "peer" : "reply")',
      )
      assert.deepEqual(order, mode === 'reply-first' ? ['reply', 'peer'] : ['peer', 'reply'])
      await evaluate('document.querySelector("button.ask-reply-q").click()')
      await until(
        () => evaluate('!!document.querySelector(".ask[data-flash], [data-flash] .ask")'),
        '跳到原问题',
      )
      assert.equal(await evaluate('document.querySelector(".ask").dataset.state'), 'answered')
    }
    await evaluate('window.searchFixture.rereadAnswerReply()')
    assert.equal(await evaluate('document.querySelectorAll(".ask-reply").length'), expected)
    report.checks.push({ name: '答复显示与重读：' + mode })
  }
  await evaluate('document.querySelector(".search-entry").click()')
  await query('AnswerPositionNeedle')
  // 卡片与独立答复各有一个命中；相邻去重由前面的场景验证。
  assert.ok(await evaluate('document.querySelector(".search-bar").textContent.includes("2")'))
  report.checks.push({ name: '隔开的答复可以在发送位置搜索' })
}
