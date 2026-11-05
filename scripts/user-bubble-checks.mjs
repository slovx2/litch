import assert from 'node:assert/strict'
import { until } from './chrome-m0/cdp.mjs'

/** 正式组件、模拟核心与真实排版；特意覆盖截断前后高度不变的更新。 */
export async function checkUserBubble(cdp, evaluate, base) {
  await cdp.call('Page.navigate', { url: `${base}test/user-bubble-fixture.html?lang=zh-CN` })
  await until(() => evaluate('!!document.querySelector(".umsg-text")'), '用户消息')
  await evaluate('document.fonts.ready')
  const frames = () =>
    evaluate(
      'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(r))))',
    )
  const text = async (value) => {
    await evaluate(`window.userBubbleFixture.text(${JSON.stringify(value)})`)
    await until(
      () =>
        evaluate(`document.querySelector('.umsg-text')?.textContent === ${JSON.stringify(value)}`),
      '正文更新',
    )
    await frames()
  }
  const measure = () =>
    evaluate(`(() => {
    const e=document.querySelector('.umsg-text'), button=e.parentElement.querySelector('button.mini');
    return {height:e.clientHeight, full:e.scrollHeight, button:button?.textContent ?? null,
      expanded:button?.getAttribute('aria-expanded'), text:e.textContent,
      markup:e.querySelectorAll('strong,hr,ol').length};
  })()`)
  const click = async () => {
    await evaluate("document.querySelector('.umsg button.mini').click()")
    await frames()
  }
  const roundTrip = async (expected) => {
    const folded = await measure()
    assert.ok(folded.full > folded.height, '样例确实被截断')
    assert.equal(folded.expanded, 'false')
    assert.ok(folded.button, '截断时展开入口常显')
    await click()
    const opened = await measure()
    assert.equal(opened.expanded, 'true')
    assert.equal(opened.full, opened.height, '展开后没有隐藏正文')
    assert.equal(opened.text, expected, '包括末尾的全文保持不变')
    assert.equal(opened.markup, 0, '用户正文仍为纯文本，Markdown 不参与折叠')
    await click()
    assert.equal((await measure()).height, folded.height, '收起恢复原来的高度')
  }
  const lines = (count) => Array.from({ length: count }, (_, i) => `第 ${i + 1} 行`).join('\n')
  await text(lines(19))
  assert.equal((await measure()).button, null)
  await text(lines(20))
  const boundary = await measure()
  assert.equal(boundary.button, null)
  await text(lines(21))
  assert.equal((await measure()).height, boundary.height, '21 行与 20 行占相同的截断高度')
  await roundTrip(lines(21))
  // 从长消息变回边界高度也不应残留无用按钮。
  await text(lines(20))
  assert.equal((await measure()).button, null)

  const examples = [
    ['长消息', '我们有两个问题，需要逐项核对。'.repeat(180)],
    ['多空行', `${Array.from({ length: 9 }, (_, i) => `第 ${i + 1} 段\n\n\n`).join('')}最后一段`],
    [
      '分隔线与编号',
      `${Array.from(
        { length: 8 },
        (_, i) => `**问题 ${i + 1}**\n\n1. 保留空行和编号。\n2. 后面的内容必须可见。\n-------\n`,
      ).join('\n')}最后一段`,
    ],
  ]
  const results = []
  for (const skin of ['retro', 'human', 'standard']) {
    for (const theme of ['light', 'dark']) {
      for (const width of [1200, 900]) {
        await cdp.call('Emulation.setDeviceMetricsOverride', {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        })
        await evaluate(`window.__litchLook.set(${JSON.stringify({ skin, theme })})`)
        await evaluate('document.fonts.ready')
        for (const [name, value] of examples) {
          await text(value)
          await roundTrip(value)
          results.push({ skin, theme, width, name })
        }
      }
    }
  }
  // 保持展开状态切走再切回；组件重新挂载时也要保留收起入口。
  await click()
  await evaluate('window.userBubbleFixture.remount()')
  await frames()
  assert.equal((await measure()).expanded, 'true')
  await click()
  assert.equal((await measure()).expanded, 'false')

  // 编辑切换会替换正文 DOM。取消后新节点仍应响应后续窗口宽度变化。
  await text('编辑后的宽度回归。'.repeat(80))
  await evaluate("document.querySelector('.act-edit').click()")
  await until(() => evaluate('!!document.querySelector(".umsg-edit")'), '编辑框')
  await evaluate(
    "document.querySelector('.umsg-edit').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))",
  )
  await until(() => evaluate('!!document.querySelector(".umsg-text")'), '取消编辑')
  await frames()
  for (const width of [1600, 600, 1600]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await frames()
    const result = await measure()
    assert.equal(!!result.button, result.full > result.height, '取消编辑后的宽度变化仍重新测量')
  }
  await evaluate("window.__litchLook.set({lang:'en'})")
  await text(lines(21))
  assert.equal((await measure()).button, 'Show all')
  // 键盘入口可用，并暴露展开状态。
  await evaluate("document.querySelector('.umsg button.mini').focus()")
  assert.equal(await evaluate("document.activeElement.matches('.umsg button.mini')"), true)
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    text: '\r',
  })
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
  })
  await frames()
  assert.equal((await measure()).expanded, 'true')
  console.log(
    'user-bubble',
    JSON.stringify({
      boundary,
      cases: results.length,
      remount: true,
      editResize: true,
      keyboard: true,
    }),
  )
}
