// 侧面板和文件标签里不靠浏览器就能测的那部分：面板怎么让位、开合防重、预览与固定、树的键盘规矩、
// 只画看得见的行的算术、一行太长怎么截、把路径插进草稿。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

// 页面的钟从打开页面那一刻走起。这里拿一个假的钟，从“刚打开 20 毫秒”开始
let now = 20
mock.method(globalThis.performance, 'now', () => now)

const side = await import('../src/side/side.ts')
const state = await import('../src/files/state.ts')
const { treeMove, selectable } = await import('../src/files/nav.ts')
const { windowOf, scrollTopFor } = await import('../src/files/virtual.ts')
const lines = await import('../src/files/lines.ts')
const drafts = await import('../src/composer/drafts.ts')

test('侧面板怎么放：一直和对话并排；窗口够宽对话留 380，窗口窄了两边一起让，让到对话 320、面板 280 为止', () => {
  // 宽敞：要多宽给多宽
  assert.deepEqual(side.layoutOf(500, 1060), { mode: 'docked', width: 500 })
  // 窄一点：面板自己让，对话留 380
  assert.deepEqual(side.layoutOf(500, 800), { mode: 'docked', width: 420 })
  // 刚好放得下最窄的面板
  assert.deepEqual(side.layoutOf(500, 740), { mode: 'docked', width: 360 })
  // 再窄：两边一起让，中间是连着的（差一个像素不会跳）
  assert.deepEqual(side.layoutOf(500, 739), { mode: 'tight', width: 359 })
  assert.deepEqual(side.layoutOf(500, 670), { mode: 'tight', width: 320 })
  // 最窄的窗口（900）去掉侧栏（300）：对话 320、面板 280
  assert.deepEqual(side.layoutOf(500, 600), { mode: 'tight', width: 280 })
  // 比这还窄（本来不会有）：面板不再让，剩下的归对话
  assert.deepEqual(side.layoutOf(500, 500), { mode: 'tight', width: 280 })
  // 想要的比最窄还窄：按最窄的算
  assert.deepEqual(side.layoutOf(100, 1060), { mode: 'docked', width: 360 })
  // 哪种宽度下对话都不比 320 窄（窗口不比最窄的还窄的话）
  for (let room = 600; room <= 1400; room += 7) {
    const { width } = side.layoutOf(500, room)
    assert.ok(room - width >= side.MAIN_FLOOR, `room ${room} → 面板 ${width}`)
    assert.ok(width >= side.SIDE_FLOOR)
  }
})

test('拖宽度：不能把对话挤得比 380 还窄，也不能比最窄的面板还窄', () => {
  assert.equal(side.clampWidth(900, 1060), 680)
  assert.equal(side.clampWidth(200, 1060), 360)
  assert.equal(side.clampWidth(520.4, 1060), 520)
  // 窗口窄的时候宽度不由人拖：记下来的不比最窄的窄就行
  assert.equal(side.clampWidth(900, 600), 360)
})

test('开合侧面板：紧挨着的第二次当成同一次按键；别处要看某个标签时直接打开到那个标签', () => {
  assert.equal(side.sideNow().open, false)
  side.toggleSide()
  assert.equal(side.sideNow().open, true)
  // 同一次按键从另一条路又来了一遍（应用菜单的快捷键和页面自己的按键）
  now = 60
  side.toggleSide()
  assert.equal(side.sideNow().open, true)
  now = 260
  side.toggleSide()
  assert.equal(side.sideNow().open, false)
  side.showSideTab('files')
  assert.deepEqual(
    { open: side.sideNow().open, tab: side.sideNow().tab },
    { open: true, tab: 'files' },
  )
  // 宽度不会被设得比最窄还窄
  side.setSideWidth(10)
  assert.equal(side.sideNow().width, side.SIDE_MIN)
})

const shape = (key) =>
  state
    .treeUiNow(key)
    .tabs.map(
      (tab) =>
        `${tab.path}${tab.path === state.treeUiNow(key).active ? '*' : ''}${tab.pinned ? '' : '~'}`,
    )
    .join(' ')

test('预览与固定：预览只有一个位置，固定的留着；关掉正看着的换到旁边那个', () => {
  const key = state.treeKey('dev', '/w')
  state.openFile(key, '/w/a')
  assert.equal(shape(key), '/w/a*~')
  // 再预览一个：顶掉原来的预览
  state.openFile(key, '/w/b')
  assert.equal(shape(key), '/w/b*~')
  // 固定打开：不动那个预览，排到最后
  state.openFile(key, '/w/c', { pin: true })
  assert.equal(shape(key), '/w/b~ /w/c*')
  // 已经开着的再打开只是换过去；要求固定的顺手固定
  state.openFile(key, '/w/b')
  assert.equal(shape(key), '/w/b*~ /w/c')
  state.pinFile(key, '/w/b')
  assert.equal(shape(key), '/w/b* /w/c')
  state.openFile(key, '/w/d')
  assert.equal(shape(key), '/w/b /w/c /w/d*~')
  assert.equal(state.treeUiNow(key).selected, '/w/d')
  // 关掉正看着的（最后一个）：换到左边的
  state.closeFile(key, '/w/d')
  assert.equal(shape(key), '/w/b /w/c*')
  // 关掉不是正看着的：正看着的不变
  state.closeFile(key, '/w/b')
  assert.equal(shape(key), '/w/c*')
  state.closeFile(key, '/w/c')
  assert.equal(shape(key), '')
  assert.equal(state.treeUiNow(key).active, null)
  // 另一棵树不受影响
  assert.equal(shape(state.treeKey('dev', '/other')), '')
})

test('定位到行：同一行再要求一次也算新的一次；读不到的路径换成另一种读法', () => {
  const key = state.treeKey('dev', '/jump')
  state.openFile(key, '/jump/a.ts', { line: 12, alt: '/jump/src/a.ts', reveal: true })
  const first = state.treeUiNow(key)
  assert.deepEqual(
    { line: first.tabs[0].line, jump: first.tabs[0].jump, reveal: first.reveal },
    { line: 12, jump: 1, reveal: '/jump/a.ts' },
  )
  state.openFile(key, '/jump/a.ts', { line: 12 })
  assert.equal(state.treeUiNow(key).tabs[0].jump, 2)
  // 不带行号再打开：原来的定位留着，不算新的一次
  state.openFile(key, '/jump/a.ts')
  assert.deepEqual([state.treeUiNow(key).tabs[0].line, state.treeUiNow(key).tabs[0].jump], [12, 2])
  state.retargetFile(key, '/jump/a.ts', '/jump/src/a.ts')
  const moved = state.treeUiNow(key)
  assert.deepEqual(
    {
      path: moved.tabs[0].path,
      alt: moved.tabs[0].alt,
      active: moved.active,
      selected: moved.selected,
      reveal: moved.reveal,
    },
    {
      path: '/jump/src/a.ts',
      alt: null,
      active: '/jump/src/a.ts',
      selected: '/jump/src/a.ts',
      reveal: '/jump/src/a.ts',
    },
  )
  state.clearReveal(key, '/jump/src/a.ts')
  assert.equal(state.treeUiNow(key).reveal, null)
})

test('从别处打开文件：侧面板开到文件标签，在那个根的树里预览并露出来', () => {
  side.setSideOpen(false)
  state.openInFiles({ deviceId: 'dev', workspaceId: 'w1', root: '/r2', path: '/r2/x.md', line: 3 })
  assert.deepEqual(
    { open: side.sideNow().open, tab: side.sideNow().tab },
    { open: true, tab: 'files' },
  )
  const ui = state.treeUiNow(state.treeKey('dev', '/r2'))
  assert.deepEqual(
    { active: ui.active, reveal: ui.reveal, pinned: ui.tabs[0].pinned, line: ui.tabs[0].line },
    { active: '/r2/x.md', reveal: '/r2/x.md', pinned: false, line: 3 },
  )
  // 滚到哪了各记各的
  state.rememberTreeScroll('k1', 240)
  state.rememberViewScroll('k1', '/a', 80)
  assert.deepEqual(
    [state.treeScrollOf('k1'), state.treeScrollOf('k2'), state.viewScrollOf('k1', '/a')],
    [240, 0, 80],
  )
  assert.equal(state.viewScrollOf('k1', '/b'), 0)
  // 树的宽度：不比最窄的窄，右边的内容至少留 160
  assert.equal(state.clampTreeWidth(50, 800), state.TREE_MIN)
  assert.equal(state.clampTreeWidth(700, 800), 640)
})

const row = (path, depth, kind, expanded = false) => ({ path, depth, kind, expanded })
const ROWS = [
  row('/a', 0, 'dir', true),
  row('/a', 1, 'loading'),
  row('/b', 0, 'dir', true),
  row('/b/x.ts', 1, 'file'),
  row('/b/y', 1, 'dir'),
  row('/c.md', 0, 'file'),
]

test('树的键盘：上下跳过说明行，左右收展和进出目录，回车固定、空格预览', () => {
  assert.equal(selectable(ROWS[1]), false)
  assert.deepEqual(treeMove(ROWS, -1, 'ArrowDown', 10), { do: 'select', index: 0 })
  // 往下：跳过“正在读取”那一行
  assert.deepEqual(treeMove(ROWS, 0, 'ArrowDown', 10), { do: 'select', index: 2 })
  assert.deepEqual(treeMove(ROWS, 2, 'ArrowUp', 10), { do: 'select', index: 0 })
  assert.equal(treeMove(ROWS, 0, 'ArrowUp', 10), null)
  assert.equal(treeMove(ROWS, 5, 'ArrowDown', 10), null)
  assert.deepEqual(treeMove(ROWS, 3, 'Home', 10), { do: 'select', index: 0 })
  assert.deepEqual(treeMove(ROWS, 0, 'End', 10), { do: 'select', index: 5 })
  assert.deepEqual(treeMove(ROWS, 0, 'PageDown', 3), { do: 'select', index: 2 })
  assert.deepEqual(treeMove(ROWS, 5, 'PageUp', 3), { do: 'select', index: 3 })
  // 往右：收着的展开；展开了的走进去；里面还没到（是说明行）就不动
  assert.deepEqual(treeMove(ROWS, 4, 'ArrowRight', 10), { do: 'expand', index: 4 })
  assert.deepEqual(treeMove(ROWS, 2, 'ArrowRight', 10), { do: 'select', index: 3 })
  assert.equal(treeMove(ROWS, 0, 'ArrowRight', 10), null)
  assert.equal(treeMove(ROWS, 3, 'ArrowRight', 10), null)
  // 往左：展开了的收起；别的走到上一级
  assert.deepEqual(treeMove(ROWS, 2, 'ArrowLeft', 10), { do: 'collapse', index: 2 })
  assert.deepEqual(treeMove(ROWS, 3, 'ArrowLeft', 10), { do: 'select', index: 2 })
  assert.equal(treeMove(ROWS, 5, 'ArrowLeft', 10), null)
  assert.deepEqual(treeMove(ROWS, 3, 'Enter', 10), { do: 'open', index: 3 })
  assert.deepEqual(treeMove(ROWS, 3, ' ', 10), { do: 'preview', index: 3 })
  assert.deepEqual(treeMove(ROWS, 4, 'Enter', 10), { do: 'expand', index: 4 })
  assert.deepEqual(treeMove(ROWS, 2, ' ', 10), { do: 'collapse', index: 2 })
  assert.equal(treeMove(ROWS, 3, 'x', 10), null)
})

test('只画看得见的行：三万行里一屏只有几十行；滚到头尾不越界', () => {
  // 一行 24，高 480：看得见 20 行，上下各多画 12 行
  assert.deepEqual(windowOf(0, 480, 24, 30_000, 12), { first: 0, last: 33 })
  assert.deepEqual(windowOf(24 * 1000, 480, 24, 30_000, 12), { first: 988, last: 1033 })
  assert.deepEqual(windowOf(24 * 29_990, 480, 24, 30_000, 12), { first: 29_978, last: 30_000 })
  // 行数变少了、滚动位置还停在老地方：不画到外面去
  assert.deepEqual(windowOf(24 * 1000, 480, 24, 5, 12), { first: 4, last: 5 })
  assert.deepEqual(windowOf(0, 480, 24, 0, 12), { first: 0, last: 0 })
  // 还没量到高度的那一帧：也有东西可画
  assert.deepEqual(windowOf(0, 0, 24, 100, 12), { first: 0, last: 13 })
  // 让某一行看得见：已经看得见就不动；从上面出去的贴上沿，从下面出去的贴下沿
  assert.equal(scrollTopFor(5, 0, 480, 24, 'nearest'), null)
  assert.equal(scrollTopFor(2, 240, 480, 24, 'nearest'), 48)
  assert.equal(scrollTopFor(40, 0, 480, 24, 'nearest'), 24 * 41 - 480)
  // 定位到某一行：放在离顶三分之一的地方
  assert.equal(scrollTopFor(4199, 0, 600, 20, 'lead'), 4199 * 20 - 200)
  assert.equal(scrollTopFor(2, 0, 600, 20, 'lead'), 0)
})

test('文件按行切开；太长的一行只留开头，不从一个字中间切', () => {
  assert.deepEqual(lines.splitLines('a\nb\n'), ['a', 'b'])
  assert.deepEqual(lines.splitLines('a\n\nb'), ['a', '', 'b'])
  assert.deepEqual(lines.splitLines(''), [''])
  assert.equal(lines.longestLine(['ab', 'abcd', '']), 4)
  assert.deepEqual(lines.cutLine('abcdef', 10), { text: 'abcdef', hidden: 0 })
  assert.deepEqual(lines.cutLine('abcdef', 4), { text: 'abcd', hidden: 2 })
  // 第四个位置上是一个表情的前一半：整个留到后面
  assert.deepEqual(lines.cutLine('abc🙂def', 4), { text: 'abc', hidden: 5 })
  assert.deepEqual(
    [lines.byteSize(154), lines.byteSize(2048), lines.byteSize(300_000), lines.byteSize(3_000_000)],
    ['154 B', '2.0 KB', '293 KB', '2.9 MB'],
  )
  assert.deepEqual([lines.digitsOf(0), lines.digitsOf(99), lines.digitsOf(6008)], [2, 2, 4])
})

test('加入对话：插在光标那里，紧挨着别的字就垫一个空格；没有输入区就说没加成', () => {
  assert.deepEqual(drafts.insertIntoDraft('', 'Makefile', 0, 0), { text: 'Makefile ', caret: 9 })
  assert.deepEqual(drafts.insertIntoDraft('Makefile ', 'docs/', 9, 9), {
    text: 'Makefile docs/ ',
    caret: 15,
  })
  // 插在两个字中间：前后各垫一个空格
  assert.deepEqual(drafts.insertIntoDraft('看看这个', 'a.ts', 2, 2), {
    text: '看看 a.ts 这个',
    caret: 8,
  })
  // 选中了一段：换掉它；后面本来就有空格的不再垫
  assert.deepEqual(drafts.insertIntoDraft('看 旧的 文件', 'a.ts', 2, 4), {
    text: '看 a.ts 文件',
    caret: 6,
  })
  assert.equal(drafts.mentionText({ kind: 'file', path: 'src/a.ts', line: 12 }), 'src/a.ts:12')
  assert.equal(drafts.mentionText({ kind: 'file', path: 'docs/' }), 'docs/')
  // 没有输入区
  assert.equal(drafts.mentionInComposer({ kind: 'file', path: 'a' }), false)
  const got = []
  const first = drafts.onMention((mention) => got.push(`一:${mention.path}`))
  const second = drafts.onMention((mention) => got.push(`二:${mention.path}`))
  // 后登记的那个是眼前的
  assert.equal(drafts.mentionInComposer({ kind: 'file', path: 'a' }), true)
  second()
  assert.equal(drafts.mentionInComposer({ kind: 'file', path: 'b' }), true)
  first()
  assert.equal(drafts.mentionInComposer({ kind: 'file', path: 'c' }), false)
  assert.deepEqual(got, ['二:a', '一:b'])
})
