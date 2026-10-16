// 终端面板里两处和时序有关的小逻辑。不起浏览器：这两个文件只用到钟和一个存不存得进去都行的本地存储。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

// 页面的钟从打开页面那一刻走起。这里拿一个假的钟，从“刚打开 20 毫秒”开始
let now = 20
mock.method(globalThis.performance, 'now', () => now)

const { panelNow, togglePanel } = await import('../src/terminal/panel.ts')
const { latestOnly } = await import('../src/terminal/latest.ts')

test('开合面板：页面刚打开时的头一次算数；紧挨着的第二次当成同一次按键，不算', () => {
  assert.equal(panelNow().open, false)
  // 页面打开才 20 毫秒就按了：以前会被当成“刚刚才开合过”吃掉
  togglePanel()
  assert.equal(panelNow().open, true)
  // 同一次按键从另一条路又来了一遍（应用菜单的快捷键和页面自己的按键）
  now = 60
  togglePanel()
  assert.equal(panelNow().open, true)
  // 隔开了的就是另一次
  now = 260
  togglePanel()
  assert.equal(panelNow().open, false)
})

/** 一件自己决定什么时候等到的事 */
function pending() {
  let done = () => {}
  const wait = new Promise((resolve) => {
    done = () => resolve(undefined)
  })
  return { wait, done }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('只认最后一次：后发的先等到，先发的后到时不能把它盖掉', async () => {
  const landed = []
  const issue = latestOnly()
  const first = pending()
  const second = pending()
  issue(first.wait, () => landed.push('先发的'))
  issue(second.wait, () => landed.push('后发的'))
  second.done()
  await tick()
  assert.deepEqual(landed, ['后发的'])
  first.done()
  await tick()
  assert.deepEqual(landed, ['后发的'])
})

test('只认最后一次：按发的先后等到时，也只有最后一件落地', async () => {
  const landed = []
  const issue = latestOnly()
  const waits = [pending(), pending(), pending()]
  waits.forEach((entry, at) => {
    issue(entry.wait, () => landed.push(at))
  })
  for (const entry of waits) entry.done()
  await tick()
  assert.deepEqual(landed, [2])
})

test('只认最后一次：中间没有别的插进来，每一件都落地', async () => {
  const landed = []
  const issue = latestOnly()
  for (const name of ['一', '二']) {
    const entry = pending()
    issue(entry.wait, () => landed.push(name))
    entry.done()
    await tick()
  }
  assert.deepEqual(landed, ['一', '二'])
})
