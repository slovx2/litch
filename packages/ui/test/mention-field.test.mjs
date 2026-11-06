// 输入框里提到的会话画成片：哪几段是片、光标选区不落进片里、退格整片删、复制粘贴带上会话、撤销后找回来、草稿重开还在。
// 不起浏览器：mention-field.ts、session-hits.ts、drafts.ts 只有判断和存取。跑法：npm run test --prefix packages/ui。
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

// 协议包里文件之间按编译后的 .mjs 互相引，直接跑源码时换回 .mts
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier.startsWith('./') &&
      specifier.endsWith('.mjs') &&
      context.parentURL?.includes('/protocol/src/')
    )
      return {
        url: new URL(specifier.replace(/\.mjs$/, '.mts'), context.parentURL).href,
        shortCircuit: true,
      }
    return next(specifier, context)
  },
})

const mention = await import('../src/composer/mention-field.ts')
const {
  CLIPBOARD_TYPE,
  chipToDelete,
  chipsWithin,
  clipboardMentions,
  mentionRanges,
  snapSelection,
} = mention
const { syncMentioned } = await import('../src/composer/session-hits.ts')

const a = { threadId: 'a', title: '甲会话' }
const b = { threadId: 'b', title: 'Grok Bot 实测：主动性' }
// 0123 4 5 6 7 8 9 ...
const text = `看 @[甲会话] 和 @[Grok Bot 实测：主动性] 。`
const ranges = mentionRanges(text, [a, b])
const [first, second] = ranges

test('对上记下的会话的 @[标题] 才是片；代码里的、没记下的、手打的不算', () => {
  assert.deepEqual(
    ranges.map(({ start, end, threadId }) => [text.slice(start, end), threadId]),
    [
      ['@[甲会话]', 'a'],
      ['@[Grok Bot 实测：主动性]', 'b'],
    ],
  )
  assert.deepEqual(mentionRanges(text, [a]).length, 1)
  assert.deepEqual(mentionRanges('`@[甲会话]` 和 @[乙]', [a]), [])
  assert.deepEqual(mentionRanges(text, []), [])
  // 同一个标题写了两次：依次对给同标题的会话，多出来的对给最后一个（和对话里认回来的规矩一样）
  const twin = { threadId: 'a2', title: '甲会话' }
  assert.deepEqual(
    mentionRanges('@[甲会话] @[甲会话] @[甲会话]', [a, twin]).map((one) => one.threadId),
    ['a', 'a2', 'a2'],
  )
})

test('光标不落进片里：从前面移进来到片尾，从后面移进来到片头，点进来的到近的一头', () => {
  const inside = first.start + 2
  assert.deepEqual(
    snapSelection(ranges, { start: inside, end: inside }, { start: first.start, end: first.start }),
    { start: first.end, end: first.end },
  )
  assert.deepEqual(
    snapSelection(
      ranges,
      { start: first.end - 1, end: first.end - 1 },
      { start: first.end, end: first.end },
    ),
    { start: first.start, end: first.start },
  )
  assert.deepEqual(snapSelection(ranges, { start: first.start + 1, end: first.start + 1 }, null), {
    start: first.start,
    end: first.start,
  })
  assert.deepEqual(snapSelection(ranges, { start: first.end - 1, end: first.end - 1 }, null), {
    start: first.end,
    end: first.end,
  })
  // 片的两头、片外面：不用挪
  assert.equal(snapSelection(ranges, { start: first.start, end: first.start }, null), null)
  assert.equal(snapSelection(ranges, { start: first.end, end: first.end }, null), null)
  assert.equal(snapSelection(ranges, { start: 0, end: 1 }, null), null)
})

test('选区：Shift 加方向键扩进片里就包住整片，再缩回来就整片退出去；没动的那头落在片里扩到整片', () => {
  const grow = snapSelection(
    ranges,
    { start: first.start, end: first.start + 1 },
    { start: first.start, end: first.start },
  )
  assert.deepEqual(grow, { start: first.start, end: first.end })
  assert.deepEqual(snapSelection(ranges, { start: first.start, end: first.end - 1 }, grow), {
    start: first.start,
    end: first.start,
  })
  // 拖选从第一片中间拖到第二片中间：两头都扩到片外
  assert.deepEqual(snapSelection(ranges, { start: first.start + 1, end: second.start + 3 }, null), {
    start: first.start,
    end: second.end,
  })
})

test('退格、删除整片：紧挨在片后面按退格、紧挨在片前面按删除；选了一段、不挨着的不管', () => {
  assert.equal(chipToDelete(ranges, { start: first.end, end: first.end }, 'Backspace'), first)
  assert.equal(chipToDelete(ranges, { start: second.start, end: second.start }, 'Delete'), second)
  assert.equal(chipToDelete(ranges, { start: first.start, end: first.start }, 'Backspace'), null)
  assert.equal(chipToDelete(ranges, { start: first.end, end: first.end }, 'Delete'), null)
  assert.equal(chipToDelete(ranges, { start: first.start, end: first.end }, 'Backspace'), null)
})

test('手机上看改完的字：只删到片的一部分就整片删掉；删整片、删别处、替换的不管', () => {
  const { chipEdit } = mention
  // 退格删了片尾的 ]
  const cut = text.slice(0, first.end - 1) + text.slice(first.end)
  assert.deepEqual(chipEdit(text, cut, ranges), {
    text: text.slice(0, first.start) + text.slice(first.end),
    caret: first.start,
  })
  // 选了一段从片中间删到片外
  const span = text.slice(0, first.start + 2) + text.slice(first.end + 2)
  assert.deepEqual(chipEdit(text, span, ranges), {
    text: text.slice(0, first.start) + text.slice(first.end + 2),
    caret: first.start,
  })
  assert.equal(chipEdit(text, text.slice(0, first.start) + text.slice(first.end), ranges), null)
  assert.equal(chipEdit(text, text.slice(1), ranges), null)
  assert.equal(chipEdit(text, `${text}多`, ranges), null)
  assert.equal(chipEdit(text, `看 @[甲会X] 和`, ranges), null)
})

test('复制：整片在选区里的随文字带上；粘贴只认同一台设备的', () => {
  assert.deepEqual(chipsWithin(ranges, 0, text.length), [a, b])
  assert.deepEqual(chipsWithin(ranges, first.start, first.end), [a])
  assert.deepEqual(chipsWithin(ranges, first.start + 1, second.end), [b])
  assert.equal(CLIPBOARD_TYPE, 'application/x-litch-session-mentions')
  const raw = JSON.stringify({ device: 'local', mentions: [a, { threadId: 1 }] })
  assert.deepEqual(clipboardMentions(raw, 'local'), [a])
  assert.deepEqual(clipboardMentions(raw, 'build-01'), [])
  assert.deepEqual(clipboardMentions('不是 JSON', 'local'), [])
})

test('撤销、粘贴把 @[标题] 带回来：从记得的里找回会话；删了的不再带；同标题已带着的不重复找', () => {
  const sa = { kind: 'session', ...a }
  const sb = { kind: 'session', ...b }
  const skill = { kind: 'skill', name: 'x', path: '/x' }
  const known = [sa, sb]
  // 删掉了甲：不再带
  const dropped = syncMentioned([skill, sa, sb], `看 @[${b.title}]`, known)
  assert.deepEqual(dropped, [skill, sb])
  // 撤销回来了：找回甲，接在后面
  assert.deepEqual(syncMentioned(dropped, text, known), [skill, sb, sa])
  // 都在的原样返回（不换数组）
  const same = [sa, sb]
  assert.equal(syncMentioned(same, text, known), same)
  // 同一个标题已经带着另一个会话：不再找回
  const twin = { kind: 'session', threadId: 'a2', title: a.title }
  assert.deepEqual(syncMentioned([twin], `@[${a.title}]`, known), [twin])
})

test('草稿里提到的会话随正文存下来：重开应用还在，清空了就不留', async () => {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  }
  try {
    const before = await import('../src/composer/drafts.ts?mention-before')
    const key = 'local:s1'
    before.saveDraftExtras(key, [
      { kind: 'session', ...a },
      { kind: 'file', name: 'x.ts', path: '/w/x.ts' },
    ])
    // 重开应用：内存里的没了，提到的会话从本地存储里读回来；文件仍只在内存里
    const after = await import('../src/composer/drafts.ts?mention-after')
    assert.deepEqual(after.loadDraftExtras(key), [{ kind: 'session', ...a }])
    after.saveDraftExtras(key, [])
    const again = await import('../src/composer/drafts.ts?mention-again')
    assert.deepEqual(again.loadDraftExtras(key), [])
  } finally {
    delete globalThis.localStorage
  }
})
