import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { collectThreads } from '../src/device/catalog.mjs'
import type { AgentMessageItem, ItemView, SessionSummary } from '../src/model.mjs'
import { askReplyText } from '../src/projection/asks.mjs'
import { searchCardItem } from '../src/search/cards.mjs'
import { ConversationSearch } from '../src/search/index.mjs'
import { itemSearchParts } from '../src/search/items.mjs'
import { originalRanges, searchQuery, searchText } from '../src/search/text.mjs'
import { matchTitles } from '../src/search/titles.mjs'
import { searchTransferItem } from '../src/search/transfer.mjs'
import { searchableItems } from '../src/search/visible.mjs'

const agent = (id: string, text: string): AgentMessageItem => ({
  id,
  kind: 'agentMessage',
  text,
  phase: 'final',
  status: 'completed',
})
const plain = (item: ItemView) =>
  itemSearchParts(item)
    .map((p) => p.text)
    .join('\n')

test('Unicode 大小写扩长、emoji 与连续空白映射回原文，不把正则符号当表达式', () => {
  const text = 'İSTANBUL  👩‍💻\n搜索 **文本**'
  for (const [query, expected] of [
    ['i̇stanbul', 'İSTANBUL'],
    ['👩‍💻 搜索', '👩‍💻\n搜索'],
    ['**文本**', '**文本**'],
  ]) {
    const [range] = originalRanges(text, query!)
    assert.ok(range)
    assert.equal(text.slice(range.start, range.end), expected)
  }
  assert.deepEqual(originalRanges(text, ''), [])
  assert.equal(searchQuery('  ABC\nDef '), 'abc def')
})

test('思考、计划、问答卡可搜；工具参数、输出、命令、差异与子代理不可搜', () => {
  assert.equal(
    plain({ id: 'r', kind: 'reasoning', text: '思考摘要', status: 'completed' }),
    '思考摘要',
  )
  assert.equal(plain({ id: 'p', kind: 'plan', text: '计划内容' }), '计划内容')
  const tool: ItemView = {
    id: 't',
    kind: 'toolCall',
    source: null,
    tool: 'secret',
    input: [{ kind: 'text', text: 'secret' }],
    output: [{ kind: 'text', text: 'secret' }],
    error: null,
    durationMs: null,
    status: 'completed',
  }
  assert.equal(plain(tool), '')
  assert.ok(
    plain({
      ...tool,
      asked: {
        questions: [
          {
            header: '选择',
            question: '去哪儿',
            options: [{ label: '北京', description: '城市' }],
            answer: null,
            picked: [],
            other: null,
          },
        ],
        raw: null,
      },
    }).includes('北京'),
  )
  assert.equal(plain({ ...tool, agents: [] }), '')
  assert.equal(
    plain({
      id: 'c',
      kind: 'command',
      command: 'needle',
      output: 'needle',
      cwd: '/',
      elided: null,
      exitCode: 0,
      durationMs: 1,
      startedAt: null,
      status: 'completed',
    }),
    '',
  )
})

test('增量替换与删除不保留过期结果，命中上限不伪报总数；顺序来自回合而非更新顺序', () => {
  const index = new ConversationSearch((parts) => parts.map((p) => p.text).join('\n'))
  index.update(
    [
      { turnId: 't2', item: agent('b', 'Needle') },
      { turnId: 't1', item: agent('a', 'needle '.repeat(600)) },
    ],
    [],
  )
  const initial = index.query('NEEDLE', 1, ['a', 'b'])
  assert.equal(initial.count, 601)
  assert.equal(initial.hits.length, 500)
  assert.equal(initial.hits[0]?.turnId, 't1')
  index.update([{ turnId: 't1', item: agent('a', '改写') }], ['b'])
  assert.equal(index.query('needle', 2, ['a', 'b']).count, 0)
})

test('跨设备标题服务只匹配标题，排除临时与原生子代理，包含归档', () => {
  const summary = (id: string, title: string, searchable = true) =>
    ({ id, title, searchable, updatedAt: 1, cwd: 'needle' }) as SessionSummary
  const rows = [
    { session: summary('a', '普通 NEEDLE'), archived: false },
    { session: summary('b', '归档 needle'), archived: true },
    { session: summary('c', '子代理 needle', false), archived: false },
    { session: summary('d', '其他'), archived: false },
  ]
  assert.deepEqual(
    matchTitles(rows, 'needle').hits.map((h) => h.session.id),
    ['a', 'b'],
  )
  assert.equal(matchTitles(rows, 'needle', 1).hasMore, true)
})

test('目录游标停滞与翻页上限都报告不完整，正常终页完整', async () => {
  const result = await collectThreads(async (cursor) => ({
    data: [],
    readStates: {},
    backwardsCursor: null,
    nextCursor: cursor ?? 'stuck',
  }))
  assert.equal(result.incomplete, true)
  const complete = await collectThreads(async () => ({
    data: [],
    readStates: {},
    backwardsCursor: null,
    nextCursor: null,
  }))
  assert.equal(complete.incomplete, false)
  let pages = 0
  const capped = await collectThreads(async () => ({
    data: [],
    readStates: {},
    backwardsCursor: null,
    nextCursor: `p${++pages}`,
  }))
  assert.equal(capped.incomplete, true)
  assert.equal(pages, 500)
})

test('10,000 条目索引只重做变更项，热查询保持有界结果', () => {
  let formatted = 0
  const index = new ConversationSearch((parts) => {
    formatted++
    return parts.map((p) => p.text).join('\n')
  })
  const sources = Array.from({ length: 10_000 }, (_, i) => ({
    turnId: `t${i}`,
    item: agent(`i${i}`, `${'正文代码 abc '.repeat(100)} 命中 ${i}`),
  }))
  index.update(sources, [])
  assert.equal(formatted, 10_000)
  index.update([{ turnId: 't0', item: agent('i0', '流式追加针') }], [])
  assert.equal(formatted, 10_001)
  const start = performance.now()
  const result = index.query(
    '命中',
    1,
    sources.map((s) => s.item.id),
  )
  assert.equal(result.count, 9999)
  assert.equal(result.hits.length, 500)
  // 性能预算留给共享 CI 充足余量；浏览器探针另量实际主线程输入。
  assert.ok(performance.now() - start < 2000)
  assert.equal(searchText('中文A'), '中文a')
})

test('已答卡片把答案并回题目、隐藏答复气泡；待答题交给待答区，选项不重复', () => {
  const question: ItemView = {
    ...agent('q', ''),
    questions: [{ id: 'qid', title: '问题', options: ['选项'] }],
  }
  const answered = searchCardItem(question, { qid: '答案' }, new Set(), new Set(['qid']))
  assert.ok(answered)
  assert.equal(plain(answered), '\n问题\n答案')
  const pending = searchCardItem(question, {}, new Set(['qid']), new Set(['qid']))
  assert.ok(pending)
  assert.equal(plain(pending), '')
  const reply: ItemView = {
    id: 'u',
    kind: 'userMessage',
    attachments: [],
    text: askReplyText([{ questionItemId: 'qid', question: '问题', answer: '答案' }]),
  }
  assert.equal(searchCardItem(reply, {}, new Set(), new Set(['qid'])), null)
  assert.ok(searchCardItem(reply, {}, new Set(), new Set()), '来源缺失时答复仍显示为用户卡片')
})

test('上下文相关的希腊 sigma 大小写使用一致的规范化坐标', () => {
  const text = 'ΟΣ'
  assert.equal(searchText(text), searchText('ος'))
  assert.deepEqual(originalRanges(text, 'ος'), [{ start: 0, end: 2 }])
})

test('目录投影标记原生子代理和临时会话不可搜索，普通派出会话仍可搜索', async () => {
  const { projectSummary } = await import('../src/projection/session.mjs')
  const thread = {
    id: 't',
    name: '标题',
    preview: '',
    cwd: '/',
    updatedAt: 1,
    source: 'cli',
  } as import('../../protocol/src/index.mjs').Thread
  const scope = { harness: 'claude', workspaceId: null }
  assert.equal(projectSummary(thread, scope).searchable, true)
  assert.equal(projectSummary({ ...thread, ephemeral: true }, scope).searchable, false)
  assert.equal(projectSummary({ ...thread, parentThreadId: 'parent' }, scope).searchable, false)
})

test('搜索执行器不接收图片二进制；提醒回合的隐藏正文不产生命中', () => {
  const image: ItemView = {
    id: 'u',
    kind: 'userMessage',
    text: '正文',
    attachments: [{ kind: 'image', label: '附件名', url: 'data:image/png;base64,large' }],
  }
  const transferred = searchTransferItem(image)
  assert.equal(JSON.stringify(transferred).includes('base64'), false)
  assert.ok(plain(transferred).includes('附件名'))
  const remind: ItemView = {
    id: 'r',
    kind: 'userMessage',
    text: '隐藏提示',
    attachments: [],
    event: { kind: 'remind', notes: [] },
  }
  const answer = agent('a', '隐藏助手回应')
  const visible = searchableItems(
    {
      id: 't',
      status: 'completed',
      itemIds: ['r', 'a'],
      startedAt: null,
      durationMs: null,
      error: null,
    },
    [remind, answer],
  )
  assert.equal(visible.has('r'), false)
  assert.equal(visible.has('a'), false)
})

test('真实核心标题命令跨设备读取目录：含归档、排除临时/子代理，报告缺失入口和离线，绝不加载正文', async () => {
  const { createCore } = await import('../src/index.mjs')
  const { fakeDevice, harness } = await import('./fake-device.mjs')
  const { fakeOpener } = await import('./fake-server.mjs')
  const { thread } = await import('./fixtures.mjs')
  const { fakeClock, settle } = await import('./helpers.mjs')
  const first = fakeDevice([
    harness('pi', {
      threads: [
        thread({ id: 'a', name: 'Needle active' }),
        thread({ id: 'temp', name: 'Needle temporary', ephemeral: true }),
        thread({ id: 'sub', name: 'Needle child', parentThreadId: 'a' }),
      ],
      archived: [thread({ id: 'old', name: 'Needle archived' })],
    }),
    harness('cc', { down: { kind: 'unavailable', message: '入口不可用' } }),
  ])
  first.device.pageSize = 1
  const second = fakeDevice([
    harness('pi', { threads: [thread({ id: 'b', name: 'Needle remote' })] }),
  ])
  const a = fakeOpener(first.handlers),
    b = fakeOpener(second.handlers)
  const time = fakeClock()
  const core = createCore({
    clock: time.clock,
    version: 'test',
    devices: [
      {
        id: 'a',
        name: 'A',
        host: 'fixture-a',
        kind: 'local',
        target: null,
        wire: 'blue',
        open: a.open,
      },
      {
        id: 'b',
        name: 'B',
        host: 'fixture-b',
        kind: 'local',
        target: null,
        wire: 'green',
        open: b.open,
      },
    ],
  })
  const never = { aborted: false, addEventListener() {} }
  const search = (deviceId: string) =>
    core.command('search.titles', { deviceId, query: 'needle' }, never) as Promise<
      import('../src/search/model.mjs').TitleSearchResult
    >
  try {
    core.start()
    await settle()
    await Promise.all(
      ['a', 'b'].map((deviceId) => core.command('device.loadArchived', { deviceId }, never)),
    )
    const local = await search('a'),
      remote = await search('b')
    assert.deepEqual(local.hits.map((h) => h.session.id).sort(), ['a', 'old'])
    assert.equal(local.hits.find((h) => h.session.id === 'old')?.archived, true)
    assert.equal(local.complete, false)
    assert.ok(local.missingHarnesses.includes('cc'))
    assert.equal(remote.complete, true)
    assert.deepEqual(
      remote.hits.map((h) => h.session.id),
      ['b'],
    )
    b.last().drop()
    await settle()
    const offline = await search('b')
    assert.equal(offline.online, false)
    assert.equal(offline.complete, false)
    assert.deepEqual(
      offline.hits.map((h) => h.session.id),
      ['b'],
    )
    assert.equal(
      [...a.last().seen, ...b.last().seen].filter(
        (r) => r.method === 'thread/read' || r.method === 'thread/resume',
      ).length,
      0,
    )
  } finally {
    core.stop()
  }
})
