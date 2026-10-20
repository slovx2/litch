// 对话区的过程：一个回合分成用户消息、过程（说明段、步骤组、子代理那一行）、最终回答；
// 步骤组的汇总；整段过程什么时候收起来。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  answerOf,
  bucketItems,
  type CommandItem,
  type FileChangeItem,
  type ItemView,
  processFolded,
  processSettled,
  processTally,
  stepsTally,
  type ToolCallItem,
  toolKind,
} from '../src/index.mjs'

test('分块：说明把工具调用切成几组，最后一条 final 是最终回答，其余都进过程', () => {
  const blocks = bucketItems([
    { id: 'u', kind: 'userMessage' },
    { id: 'n1', kind: 'agentMessage', phase: 'commentary' },
    { id: 'r', kind: 'reasoning' },
    { id: 'c1', kind: 'command' },
    { id: 'n2', kind: 'agentMessage', phase: 'commentary' },
    { id: 'f', kind: 'fileChange' },
    { id: 'c2', kind: 'command' },
    { id: 'a', kind: 'agentMessage', phase: 'final' },
  ])
  assert.deepEqual(blocks, [
    { type: 'user', itemId: 'u' },
    {
      type: 'process',
      key: 'n1',
      parts: [
        { type: 'note', itemId: 'n1' },
        { type: 'steps', key: 'r', itemIds: ['r', 'c1'] },
        { type: 'note', itemId: 'n2' },
        { type: 'steps', key: 'f', itemIds: ['f', 'c2'] },
      ],
    },
    { type: 'answer', itemId: 'a' },
  ])
})

test('分块：计划、待办、派出的子会话露在外面，把过程分成几段；子代理那一行排在过程里', () => {
  assert.deepEqual(
    bucketItems([
      { id: 'u', kind: 'userMessage' },
      { id: 'c1', kind: 'command' },
      { id: 'd', kind: 'todo' },
      { id: 'c2', kind: 'command' },
      { id: 'sa', kind: 'toolCall', card: 'inline' },
      { id: 'w', kind: 'toolCall' },
      { id: 's', kind: 'toolCall', card: 'outside' },
      { id: 'p', kind: 'plan' },
      { id: 'a', kind: 'agentMessage', phase: 'final' },
      { id: 'q', kind: 'toolCall', quiet: true },
    ]),
    [
      { type: 'user', itemId: 'u' },
      { type: 'process', key: 'c1', parts: [{ type: 'steps', key: 'c1', itemIds: ['c1'] }] },
      { type: 'todo', itemId: 'd' },
      {
        type: 'process',
        key: 'c2',
        parts: [
          { type: 'steps', key: 'c2', itemIds: ['c2'] },
          { type: 'card', itemId: 'sa' },
          { type: 'steps', key: 'w', itemIds: ['w'] },
        ],
      },
      { type: 'card', itemId: 's' },
      { type: 'plan', itemId: 'p' },
      { type: 'answer', itemId: 'a' },
    ],
  )
})

test('分块：组里再来条目，组和过程的标识都不变', () => {
  const before = bucketItems([{ id: 'r', kind: 'reasoning' }])
  const after = bucketItems([
    { id: 'r', kind: 'reasoning' },
    { id: 'c', kind: 'command' },
  ])
  assert.deepEqual(before, [
    { type: 'process', key: 'r', parts: [{ type: 'steps', key: 'r', itemIds: ['r'] }] },
  ])
  assert.deepEqual(after, [
    { type: 'process', key: 'r', parts: [{ type: 'steps', key: 'r', itemIds: ['r', 'c'] }] },
  ])
})

test('分块：只有提示的回合，提示直接露在外面；提示夹在别的条目中间时进步骤组', () => {
  assert.deepEqual(
    bucketItems([
      { id: 'n', kind: 'notice' },
      { id: 'w', kind: 'toolCall', quiet: true },
    ]),
    [{ type: 'notes', key: 'n', itemIds: ['n'] }],
  )
  assert.deepEqual(
    bucketItems([
      { id: 'u', kind: 'userMessage' },
      { id: 'n', kind: 'notice' },
    ]),
    [
      { type: 'user', itemId: 'u' },
      { type: 'process', key: 'n', parts: [{ type: 'steps', key: 'n', itemIds: ['n'] }] },
    ],
  )
})

test('最终回答的认定：有 final 取最后一条 final；分不清阶段的取最后一条助手消息；最后是说明就没有', () => {
  assert.equal(
    answerOf([
      { id: 'f1', kind: 'agentMessage', phase: 'final' },
      { id: 'c', kind: 'agentMessage', phase: 'commentary' },
      { id: 'f2', kind: 'agentMessage', phase: 'final' },
      { id: 'x', kind: 'agentMessage', phase: 'commentary' },
    ]),
    'f2',
  )
  assert.equal(
    answerOf([
      { id: 'u1', kind: 'agentMessage', phase: 'unknown' },
      { id: 't', kind: 'toolCall' },
      { id: 'u2', kind: 'agentMessage', phase: 'unknown' },
    ]),
    'u2',
  )
  assert.equal(
    answerOf([
      { id: 'u1', kind: 'agentMessage', phase: 'unknown' },
      { id: 'c', kind: 'agentMessage', phase: 'commentary' },
    ]),
    undefined,
  )
  assert.equal(answerOf([{ id: 'c', kind: 'command' }]), undefined)
  // 分不清阶段的：前面几条都是说明，进过程
  assert.deepEqual(
    bucketItems([
      { id: 'u', kind: 'userMessage' },
      { id: 'm1', kind: 'agentMessage', phase: 'unknown' },
      { id: 't', kind: 'toolCall' },
      { id: 'm2', kind: 'agentMessage', phase: 'unknown' },
    ]),
    [
      { type: 'user', itemId: 'u' },
      {
        type: 'process',
        key: 'm1',
        parts: [
          { type: 'note', itemId: 'm1' },
          { type: 'steps', key: 't', itemIds: ['t'] },
        ],
      },
      { type: 'answer', itemId: 'm2' },
    ],
  )
  // 中断了的回合：只有说明，没有最终回答，都在过程里
  assert.deepEqual(
    bucketItems([
      { id: 'u', kind: 'userMessage' },
      { id: 'm', kind: 'agentMessage', phase: 'commentary' },
    ]),
    [
      { type: 'user', itemId: 'u' },
      { type: 'process', key: 'm', parts: [{ type: 'note', itemId: 'm' }] },
    ],
  )
})

test('过程什么时候告一段落：回合结束，或者最终回答写完（声明了一开始就知道的，一开始就算）', () => {
  assert.equal(processSettled(false, []), true)
  assert.equal(processSettled(true, []), false)
  const answer = (phase: string, status: string) => [
    { kind: 'agentMessage' as const, phase, status },
  ]
  assert.equal(processSettled(true, answer('final', 'completed')), true)
  assert.equal(
    processSettled(true, answer('final', 'inProgress')),
    false,
    '刚开始就自称最终回答的不算',
  )
  assert.equal(processSettled(true, answer('unknown', 'completed')), false)
  assert.equal(processSettled(true, answer('final', 'inProgress'), true), true)
  assert.equal(processSettled(true, answer('unknown', 'inProgress'), true), false)
  assert.equal(processSettled(true, [], true), false)
})

test('整段过程收不收：告一段落了才收；手动展开过、子代理没做完都不收', () => {
  assert.equal(processFolded(true, false, false), true)
  assert.equal(processFolded(false, false, false), false)
  assert.equal(processFolded(true, true, false), false, '手动展开过')
  assert.equal(processFolded(true, false, true), false, '还有子代理在跑')
})

// ---------- 汇总 ----------

const command = (id: string, fields: Partial<CommandItem> = {}): CommandItem => ({
  id,
  kind: 'command',
  command: 'ls',
  cwd: '/w',
  output: '',
  elided: null,
  exitCode: 0,
  durationMs: 1000,
  startedAt: null,
  status: 'completed',
  ...fields,
})

const tool = (id: string, name: string, fields: Partial<ToolCallItem> = {}): ToolCallItem => ({
  id,
  kind: 'toolCall',
  source: 'claude-code',
  tool: name,
  input: [],
  output: [],
  error: null,
  durationMs: null,
  status: 'completed',
  ...fields,
})

const change = (
  id: string,
  entries: {
    path: string
    change: 'add' | 'update' | 'delete'
    added?: number
    removed?: number
  }[],
  status: FileChangeItem['status'] = 'completed',
): FileChangeItem => ({
  id,
  kind: 'fileChange',
  status,
  changes: entries.map((entry) => ({
    path: entry.path,
    change: entry.change,
    movedTo: null,
    added: entry.added ?? 0,
    removed: entry.removed ?? 0,
    diff: '',
    diffKind: 'patch',
    elided: null,
  })),
})

const thought = (id: string): ItemView => ({
  id,
  kind: 'reasoning',
  text: '',
  status: 'completed',
})

test('工具名认成哪种动作：各家的读、搜、列目录、看网页，别的是调用工具', () => {
  assert.equal(toolKind('Read src/a.ts'), 'read')
  assert.equal(toolKind('read'), 'read')
  assert.equal(toolKind('Grep foo (src)'), 'search')
  assert.equal(toolKind('Glob **/*.ts'), 'search')
  assert.equal(toolKind('ls'), 'list')
  assert.equal(toolKind('WebFetch'), 'web')
  assert.equal(toolKind('browser_click'), 'tool')
  assert.equal(toolKind({ key: 'collab.wait' } as never), 'tool')
})

test('汇总：动作按先后排、带个数；同一个文件改几次算一个；思考不计入；改动行数和用时加起来', () => {
  const tally = stepsTally([
    thought('r'),
    tool('t1', 'Read a.ts'),
    tool('t2', 'Read b.ts'),
    command('c1', { durationMs: 1500 }),
    change('f1', [{ path: 'a.ts', change: 'update', added: 3, removed: 1 }]),
    change('f2', [
      { path: 'a.ts', change: 'update', added: 2 },
      { path: 'n.ts', change: 'add', added: 10 },
    ]),
    tool('t3', 'Grep x', { durationMs: 500 }),
    { id: 'w', kind: 'webSearch', query: 'q' },
  ])
  assert.deepEqual(tally.counts, [
    { kind: 'read', n: 2 },
    { kind: 'command', n: 1 },
    { kind: 'update', n: 1 },
    { kind: 'add', n: 1 },
    { kind: 'search', n: 1 },
    { kind: 'web', n: 1 },
  ])
  assert.equal(tally.thoughts, 1)
  assert.equal(tally.steps, 7)
  assert.equal(tally.added, 15)
  assert.equal(tally.removed, 1)
  assert.equal(tally.durationMs, 2000)
  assert.equal(tally.failed, 0)
})

test('汇总：失败的命令、工具、改文件都计入失败；拒绝的另算、不算失败', () => {
  const tally = stepsTally([
    command('c1', { exitCode: 1 }),
    command('c2', { status: 'failed', exitCode: null }),
    command('c3', { status: 'declined', exitCode: -1 }),
    tool('t1', 'mcp_tool', { status: 'failed' }),
    tool('t2', 'other', { error: [{ kind: 'text', text: 'boom' }] }),
    change('f', [{ path: 'a', change: 'update' }], 'declined'),
    change('g', [{ path: 'b', change: 'update' }], 'failed'),
  ])
  assert.equal(tally.failed, 5)
  assert.equal(tally.declined, 2)
})

test('汇总：只有思考的组没有动作；只有一条提示时带上它的文字', () => {
  const only = stepsTally([thought('r1'), thought('r2')])
  assert.deepEqual(only.counts, [])
  assert.equal(only.thoughts, 2)
  assert.equal(only.steps, 0)
  assert.equal(only.durationMs, null)
  const notice = stepsTally([
    { id: 'n', kind: 'notice', label: { key: 'notice.contextCompaction' } as never, detail: null },
  ])
  assert.deepEqual(notice.counts, [{ kind: 'notice', n: 1 }])
  assert.deepEqual(notice.notice, { key: 'notice.contextCompaction' })
  assert.equal(notice.steps, 0)
})

test('整段过程的汇总：说明段、工具步骤、子代理、失败和被拒', () => {
  const tally = processTally([
    { id: 'm1', kind: 'agentMessage', text: '', phase: 'commentary', status: 'completed' },
    thought('r'),
    command('c1'),
    command('c2', { exitCode: 2 }),
    tool('sa', 'x', {
      tool: { key: 'collab.spawnAgent' } as never,
      agents: [
        { threadId: 'k1', state: 'completed', message: null },
        { threadId: 'k2', state: 'errored', message: null },
      ],
    }),
    tool('w', 'x', { tool: { key: 'collab.wait' } as never, agents: [] }),
    { id: 'm2', kind: 'agentMessage', text: '', phase: 'commentary', status: 'completed' },
    change('f', [{ path: 'a', change: 'update' }], 'declined'),
  ])
  assert.deepEqual(tally, {
    notes: 2,
    steps: 4,
    agents: 2,
    failed: 1,
    declined: 1,
    agentsFailed: 1,
  })
})
