import assert from 'node:assert/strict'
import test from 'node:test'
import { planCardMotion, revealOffset, wholeCardClick } from '../src/manager/card-motion.ts'

const view = { top: 0, bottom: 600 }
const box = (top, height) => ({ top, height })

test('提交后离开的卡收拢、展开收起的卡做高度过渡、新卡淡入；只管可视区里的变化', () => {
  const plan = planCardMotion(
    [
      ['D-1', box(0, 100)],
      ['D-2', box(116, 300)],
      ['D-3', box(432, 100)],
      ['D-9', box(900, 100)],
    ],
    [
      ['D-1', box(0, 400)],
      ['D-3', box(416, 100)],
      ['D-4', box(532, 100)],
      ['D-8', box(1200, 100)],
    ],
    view,
  )
  assert.deepEqual(plan, {
    resize: [{ key: 'D-1', from: 100, to: 400 }],
    exit: ['D-2'],
    enter: ['D-4'],
  })
})

test('换页签、换筛选（没有共同的卡）或改了排序都不过渡；没有变化也不过渡', () => {
  assert.equal(planCardMotion([['D-1', box(0, 100)]], [['R-1', box(0, 100)]], view), null)
  assert.equal(
    planCardMotion(
      [
        ['D-1', box(0, 100)],
        ['D-2', box(116, 100)],
      ],
      [
        ['D-2', box(0, 100)],
        ['D-1', box(116, 100)],
      ],
      view,
    ),
    null,
  )
  assert.equal(planCardMotion([['D-1', box(0, 100)]], [['D-1', box(40, 100.5)]], view), null)
})

test('展开后露出不到一半才滚，卡头不越过可视区顶端；卡头在可视区上方时先让卡头露出', () => {
  // 露出大半：不动
  assert.equal(revealOffset(box(200, 700), view), 0)
  // 整张都露出：不动
  assert.equal(revealOffset(box(500, 90), view), 0)
  // 贴近底部展开：滚到整张露出
  assert.equal(revealOffset(box(500, 200), view), 108)
  // 太高放不下：卡头停在顶端留 8 像素
  assert.equal(revealOffset(box(500, 900), view), 492)
  assert.equal(revealOffset(box(-50, 300), view), -58)
})

const card = (inside) => ({ contains: (node) => inside.includes(node) })
const element = (match) => ({ closest: () => match })
const click = (patch = {}) => ({
  button: 0,
  detail: 1,
  target: element(null),
  clientX: 10,
  clientY: 10,
  ...patch,
})
const selection = (text, node) => ({
  isCollapsed: !text,
  anchorNode: node,
  focusNode: node,
  toString: () => text,
})

test('整卡点击：空白处开合；点控件、拖动、双击选词、卡内有选中文字都不开合', () => {
  const button = {}
  const text = {}
  const inside = card([button, text])
  assert.equal(wholeCardClick(click(), inside, { x: 10, y: 10 }, null), true)
  assert.equal(wholeCardClick(click({ target: element(button) }), inside, null, null), false)
  // 控件不在这张卡里（比如卡片外层的折叠组）：照常开合
  assert.equal(wholeCardClick(click({ target: element({}) }), inside, null, null), true)
  assert.equal(wholeCardClick(click({ button: 1 }), inside, null, null), false)
  assert.equal(wholeCardClick(click({ detail: 2 }), inside, null, null), false)
  assert.equal(wholeCardClick(click({ clientX: 40 }), inside, { x: 10, y: 10 }, null), false)
  assert.equal(wholeCardClick(click(), inside, null, selection('选中的字', text)), false)
  // 选区在别处、或只是光标：照常开合
  assert.equal(wholeCardClick(click(), inside, null, selection('别处', {})), true)
  assert.equal(wholeCardClick(click(), inside, null, selection('', text)), true)
})
