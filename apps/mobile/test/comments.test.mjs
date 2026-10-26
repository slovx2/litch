// 选中回答加评论（src/detail/comments/、composer/drafts.ts）：回答里的 [N] 改成记号、在对话的行里找原文、
// 草稿里的评论落盘与上限。发出去的格式与认回来在核心（packages/core 的 comments 单测）。
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { files } from 'expo-file-system'
import {
  commentHref,
  findQuote,
  linkCommentRefs,
  parseCommentHref,
  plainOf,
  snippet,
  UNKNOWN_ITEM,
} from '../src/detail/comments/refs.ts'

const label = (n) => `评论 ${n}`

test('[N] 改成 litch-comment: 链接：编号超出的、代码里的、链接和引用式定义不动', () => {
  assert.equal(
    linkCommentRefs('关于 [1]：对。[2] 也是。[3] 不认', 2, label),
    '关于 [评论 1](litch-comment:1)：对。[评论 2](litch-comment:2) 也是。[3] 不认',
  )
  const untouched = [
    '```\n[1]\n```',
    '    [1] 缩进的代码',
    '`arr[1]` 和 `[1]`',
    '[1](https://a.b)',
    '[文档][1]',
    '[1]: https://a.b',
    '![1]',
  ]
  for (const text of untouched) assert.equal(linkCommentRefs(text, 3, label), text, text)
  assert.equal(linkCommentRefs('[0] 和 [1]', 1, label), '[0] 和 [评论 1](litch-comment:1)')
  assert.equal(linkCommentRefs('[1]', 0, label), '[1]', '没带评论的回合不认')
  assert.equal(
    linkCommentRefs('`x` [1] `y`', 1, label),
    '`x` [评论 1](litch-comment:1) `y`',
    '行内代码之间的照认',
  )
})

test('litch-comment: 链接来回；别的链接是 null', () => {
  assert.equal(parseCommentHref(commentHref(3)), 3)
  assert.equal(parseCommentHref('litch-comment:0'), null)
  assert.equal(parseCommentHref('litch-comment:x'), null)
  assert.equal(parseCommentHref('litch-file:a.ts'), null)
})

test('摘要：空白并成一个，长了截掉', () => {
  assert.equal(snippet('  一段\n\n话  ', 10), '一段 话')
  assert.equal(snippet('abcdefghij', 4), 'abcd…')
})

// 行从新到旧排，和对话区一样
const md = (key, turnId, itemId, text, plan = false) => ({
  type: 'md',
  key,
  turnId,
  itemId,
  text,
  open: false,
  live: false,
  plan,
  first: true,
})
const rows = [
  { type: 'status', key: 't2:status', turnId: 't2', status: 'completed', durationMs: 1 },
  md('a2:0', 't2', 'a2', '第二回合的回答，也说到了缓存要清掉'),
  { type: 'user', key: 'u2', turnId: 't2', text: '<litch-comments>…', attachments: [] },
  { type: 'status', key: 't1:status', turnId: 't1', status: 'completed', durationMs: 1 },
  md('a1:1', 't1', 'a1', '第二块：缓存要清掉，不然会读到旧的'),
  md('a1:0', 't1', 'a1', '第一块：先说结论'),
  md('p1:0', 't1', 'p1', '计划里也写了缓存要清掉', true),
  { type: 'user', key: 'u1', turnId: 't1', text: '问题', attachments: [] },
]

test('找原文：知道条目的在那条回答里找，找不到落在它的第一块', () => {
  assert.equal(findQuote(rows, { quote: '缓存要清掉，不然', itemId: 'a1' }), 4)
  assert.equal(findQuote(rows, { quote: '对不上的字', itemId: 'a1' }), 5)
  assert.equal(findQuote(rows, { quote: '缓存', itemId: 'gone' }), -1)
})

test('找原文：只知道回合的从那一回合往前找，计划不算；都不知道的找整个对话', () => {
  // 第二回合的回答里也有这句，但评论是第二回合发的，原文只能在更早的地方
  assert.equal(findQuote(rows, { quote: '缓存要清掉\n下一行', turnId: 't2' }), 4)
  assert.equal(findQuote(rows, { quote: '计划里也写了', turnId: 't2' }), -1)
  assert.equal(findQuote(rows, { quote: '缓存要清掉', itemId: UNKNOWN_ITEM }), 1)
  assert.equal(findQuote(rows, { quote: '   ', turnId: 't2' }), -1)
})

test('找原文：选字回复引用的是画出来的字，块里是源码；行内代码、加粗、链接、转义都剥掉再比', () => {
  const marked = [
    md('b1:2', 't3', 'b1', '最后一块：没有记号的字'),
    md(
      'b1:1',
      't3',
      'b1',
      '重试在 `src/net/client.ts` 第 12 行的 `retry`，**超时的请求**不该重试，见 [文档](https://x.test/a)。',
    ),
    md('b1:0', 't3', 'b1', '1\\. 先看 <https://x.test/b> 再说，snake_case 的名字也行'),
  ]
  // 画出来的字：没有反引号、星号、链接地址
  assert.equal(
    findQuote(marked, { quote: 'src/net/client.ts 第 12 行的 retry，超时', itemId: 'b1' }),
    1,
  )
  assert.equal(findQuote(marked, { quote: '超时的请求不该重试，见 文档。', itemId: 'b1' }), 1)
  assert.equal(findQuote(marked, { quote: '1. 先看 https://x.test/b 再说', turnId: 't4' }), 2)
  assert.equal(findQuote(marked, { quote: 'snake_case 的名字', itemId: 'b1' }), 2)
  // 全文页选的是源码，照样认得
  assert.equal(findQuote(marked, { quote: '`retry`，**超时的请求**', itemId: 'b1' }), 1)
  assert.equal(plainOf('a  `b`\n  **c** [d](e)'), 'a b c d')
})

let generation = 0
const fresh = (path) => import(`${path}?run=${++generation}`)

beforeEach(() => files.clear())

const comment = (n) => ({ kind: 'comment', itemId: `a${n}`, quote: `引用 ${n}`, note: '' })

test('草稿里的评论：订阅得到变化、最多十条、落盘重开还在、清空草稿一起清', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const drafts = await fresh('../src/detail/composer/drafts.ts')
  const key = drafts.draftKey('dev', 's1')
  let heard = 0
  const off = drafts.subscribeDraftComments(() => heard++)
  const before = drafts.loadDraftComments(key)
  assert.deepEqual(before, [])
  assert.equal(drafts.loadDraftComments(key), before, '没改过时给同一个数组（订阅方据此不重画）')
  for (let n = 1; n <= 10; n++) assert.equal(drafts.addDraftComment(key, comment(n)), true)
  assert.equal(drafts.addDraftComment(key, comment(11)), false, '满十条加不进去')
  assert.equal(drafts.loadDraftComments(key).length, 10)
  assert.equal(heard, 10)
  off()
  t.mock.timers.tick(600)
  assert.ok(files.has('doc:/draft-comments.json'))

  const reopened = await fresh('../src/detail/composer/drafts.ts')
  assert.deepEqual(reopened.loadDraftComments(key)[0], comment(1))
  reopened.saveDraftComments(key, reopened.loadDraftComments(key).slice(1))
  assert.equal(reopened.loadDraftComments(key)[0].quote, '引用 2', '删掉一条，后面的往前挪')
  reopened.dropDraft(key)
  assert.deepEqual(reopened.loadDraftComments(key), [])
  reopened.flushDrafts()
  const again = await fresh('../src/detail/composer/drafts.ts')
  assert.deepEqual(again.loadDraftComments(key), [])
})

test('草稿里的评论：文件里形状不对的条目不收', async () => {
  files.set(
    'doc:/draft-comments.json',
    JSON.stringify([
      ['k', [comment(1), { kind: 'comment', quote: 1 }, null]],
      ['bad', 'x'],
    ]),
  )
  const drafts = await fresh('../src/detail/composer/drafts.ts')
  assert.deepEqual(drafts.loadDraftComments('k'), [comment(1)])
  assert.deepEqual(drafts.loadDraftComments('bad'), [])
})

test('选字回复：退出选字、弹出写评论的对话框，加上后带着评论加到输入框上面；取消什么都不加；满了不退出、说满了', async () => {
  const { CommentsHub } = await import('../src/detail/comments/hub.ts')
  const drafts = await import('../src/detail/composer/drafts.ts')
  const key = drafts.draftKey('dev', 'select')
  const hub = new CommentsHub(/** @type {any} */ ({}), key)
  let heard = 0
  const off = hub.subscribe(() => heard++)
  hub.select('a1')
  assert.equal(hub.selecting, 'a1')
  assert.equal(hub.reply('a1', '   '), false, '只选了空白不算')
  assert.equal(hub.reply('a1', '  缓存要清掉 \n'), true)
  assert.equal(hub.selecting, null)
  assert.deepEqual(hub.replying, { itemId: 'a1', quote: '缓存要清掉' })
  assert.deepEqual(drafts.loadDraftComments(key), [], '写好评论之前不加')
  hub.replied('换个地方清')
  assert.equal(hub.replying, null)
  assert.deepEqual(drafts.loadDraftComments(key), [
    { kind: 'comment', itemId: 'a1', quote: '缓存要清掉', note: '换个地方清' },
  ])
  hub.select('a1')
  assert.equal(hub.reply('a1', '另一段'), true)
  hub.replied(null)
  assert.equal(hub.replying, null)
  assert.equal(drafts.loadDraftComments(key).length, 1, '取消了不加')
  for (let n = 2; n <= 10; n++) drafts.addDraftComment(key, comment(n))
  hub.select('a2')
  assert.equal(hub.reply('a2', '再引一段'), false)
  assert.equal(hub.selecting, 'a2', '满了留在选字里，可以先去删掉几条')
  assert.equal(hub.replyFull, true)
  hub.select(null)
  assert.equal(hub.replyFull, false)
  assert.ok(heard >= 4)
  off()
})
