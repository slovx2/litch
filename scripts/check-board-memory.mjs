// 正式分页组件的阅读状态回归，由 check-console-cards.mjs 共用隔离浏览器运行。
import assert from 'node:assert/strict'
import { until } from './chrome-m0/cdp.mjs'

export async function checkMobileBoardMemory({ read, click }) {
  const host = `document.querySelector('[data-testid="manager-board-scroll"]')`
  const ready = () => until(() => read(`getComputedStyle(${host}).opacity === '1'`), '手机看板恢复')
  const state = () =>
    read(`({
    selected: document.querySelector('[data-testid^="paging-detail:"]')?.getAttribute('data-testid') ?? null,
    y: ${host}.scrollTop
  })`)
  const scroll = async (y) => {
    await read(`${host}.scrollTop = ${y}`)
    await read('new Promise(r=>setTimeout(r,150))')
    return state()
  }
  const restored = async (expected, label) => {
    await ready()
    await read('new Promise(r=>setTimeout(r,150))')
    const actual = await state()
    assert.equal(actual.selected, expected.selected, `${label}：展开卡片`)
    assert.ok(
      Math.abs(actual.y - expected.y) < 2,
      `${label}：滚动 ${JSON.stringify({ expected, actual })}`,
    )
  }
  await click('[data-testid="manager-category:decision"]')
  await click('[data-testid="paging-object:D-2"]')
  const decision = await scroll(380)
  assert.equal(decision.y, 380)
  await click('[data-testid="manager-category:request"]')
  await click('[data-testid="paging-object:R-1"]')
  const request = await scroll(180)
  await click('[data-testid="manager-category:decision"]')
  await restored(decision, '手机类别')
  await click('[data-testid="paging-filter:all"]')
  await click('[data-testid="paging-object:D-3"]')
  const all = await scroll(260)
  await click('[data-testid="paging-filter:open"]')
  await restored(decision, '手机待定')
  await click('[data-testid="paging-filter:all"]')
  await restored(all, '手机全部')
  await click('[data-testid="manager-tab:chat"]')
  await read('new Promise(r=>setTimeout(r,300))')
  await click('[data-testid="manager-tab:console"]')
  await restored(all, '手机对话往返')
  await click('[data-testid="manager-category:request"]')
  await restored(request, '手机请求')
  // 概览四格沿用普通类别导航：不能覆盖已记住的筛选、展开卡片与滚动位置。
  await click('[data-testid="manager-tab:overview"]')
  await click('[data-testid="overview-count:decision"]')
  await restored(all, '手机概览跳转决策')
  await click('[data-testid="manager-tab:overview"]')
  await click('[data-testid="overview-count:request"]')
  await restored(request, '手机概览跳转请求')
  console.log('手机看板记忆：类别、状态筛选、对话页签往返通过')
}

export async function checkBoardMemory({ call, read, click }) {
  await call('Page.navigate', {
    url: 'http://127.0.0.1:5297/test/console-cards-fixture.html?lang=zh-CN&memory=1&tab=decisions',
  })
  const frame = () => read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  const ready = () =>
    until(
      () =>
        read(`(() => {
    const root = document.querySelector('[data-manager-paging]');
    return root && getComputedStyle(root).visibility !== 'hidden';
  })()`),
      '看板恢复完成',
    )
  const state = () =>
    read(`({
    selected: document.querySelector('[data-paging-detail]')?.dataset.pagingDetail ?? null,
    y: document.querySelector('.mg-body').scrollTop,
    // 提交条自身的淡入不改变卡片布局；这里只检查列表卡片的开合与离场过渡。
    animations: [...document.querySelectorAll('[data-manager-paging] > [data-motion-key], [data-manager-paging] > [data-motion-ghost]')].flatMap(e => e.getAnimations()).map(a => ({
      kind: a.constructor.name, target: a.effect?.target?.outerHTML.slice(0, 300),
      frames: a.effect?.getKeyframes(), state: a.playState
    }))
  })`)
  const scroll = async (y) => {
    await read(`document.querySelector('.mg-body').scrollTop = ${y}`)
    await frame()
    return state()
  }
  const open = async (id) => {
    await click(`[data-paging-object="${id}"] > button`)
    await read('new Promise(r=>setTimeout(r,700))')
  }
  const restored = async (expected, label) => {
    await ready()
    await frame()
    const actual = await state()
    assert.equal(actual.selected, expected.selected, `${label}：展开卡片`)
    assert.ok(
      Math.abs(actual.y - expected.y) < 2,
      `${label}：滚动 ${JSON.stringify({ expected, actual })}`,
    )
    assert.equal(
      actual.animations.length,
      0,
      `${label}：恢复不播放开合动画 ${JSON.stringify(actual.animations)}`,
    )
  }
  await ready()
  await open('D-2')
  const decision = await scroll(380)
  assert.equal(decision.selected, 'D-2')
  assert.equal(decision.y, 380)
  await click('[data-memory-tab="requests"]')
  await open('R-1')
  const request = await scroll(180)
  await click('[data-memory-tab="decisions"]')
  await restored(decision, '一级页签')
  await click('[data-paging-filter="all"]')
  await open('D-3')
  const all = await scroll(260)
  await click('[data-paging-filter="open"]')
  await restored(decision, '待定筛选')
  await click('[data-paging-filter="all"]')
  await restored(all, '全部筛选')
  await click('[data-memory-tab="requests"]')
  await restored(request, '请求页签')
  await click('[data-memory-tab="decisions"]')
  await restored(all, '状态筛选仍为全部')
  await click('[data-memory-tab="overview"]')
  await click('[data-overview-count="requests"]')
  await restored(request, '概览跳转请求')
  await click('[data-memory-tab="overview"]')
  await click('[data-overview-count="decisions"]')
  await restored(all, '概览跳转决策')
  await click('[data-memory-manager]')
  await restored({ selected: null, y: 0 }, '另一经理初始状态')
  await open('D-4')
  const second = await scroll(120)
  await click('[data-memory-manager]')
  await restored(all, '原经理')
  await click('[data-memory-manager]')
  await restored(second, '第二位经理')
  await click('[data-memory-manager]')
  await click('[data-memory-mount]')
  await click('[data-memory-mount]')
  await restored(all, '卸载后返回')
  await click('[data-memory-delay]')
  await read('new Promise(r=>setTimeout(r,200))')
  assert.equal(
    await read(`getComputedStyle(document.querySelector('[data-manager-paging]')).visibility`),
    'hidden',
    '详情未到时不显露错误位置',
  )
  await restored(all, '列表与详情分两次异步到达')
  await click('[data-paging-filter="open"]')
  await restored(decision, '移除前')
  await click('[data-memory-tab="requests"]')
  await click('[data-memory-remove]')
  await click('[data-memory-tab="decisions"]')
  await ready()
  const gone = await state()
  assert.equal(gone.selected, null, '已离开待定的卡不再展开')
  const nearest = await read(
    'Math.min(380, document.querySelector(".mg-body").scrollHeight - document.querySelector(".mg-body").clientHeight)',
  )
  assert.ok(
    Math.abs(gone.y - nearest) < 2,
    `卡片消失后停在附近 ${JSON.stringify({ gone, nearest })}`,
  )
  await click('[data-paging-object="D-4"] > button')
  await click('[data-memory-tab="requests"]')
  await restored(request, '开合过渡中切换')
  await read('new Promise(r=>setTimeout(r,400))')
  await restored(request, '旧过渡不再修改新页签位置')
  console.log('看板记忆：一级/二级页签、经理隔离、卸载返回、异步列表与详情、卡片消失退化通过')
}
