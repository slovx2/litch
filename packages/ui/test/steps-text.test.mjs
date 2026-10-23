// 过程区汇总行的字：步骤组那一行、正在跑的那一条、整段过程收成的那一行。用真的中英文文案。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { messageTarget, nowOf, processSummary, stepsSummary } = await import(
  '../src/transcript/steps-text.ts'
)
const { translator } = await import('../src/i18n/index.ts')

const zh = translator('zh-CN')
const en = translator('en')

const tally = (fields) => ({
  counts: [],
  thoughts: 0,
  steps: 0,
  failed: 0,
  declined: 0,
  added: 0,
  removed: 0,
  durationMs: null,
  notice: null,
  ...fields,
})

test('步骤组：动作和个数按先后连起来，量词按动作定', () => {
  const counts = [
    { kind: 'read', n: 3 },
    { kind: 'update', n: 1 },
    { kind: 'command', n: 2 },
  ]
  assert.equal(stepsSummary(tally({ counts }), zh), '读取 3 个文件，修改 1 个文件，运行 2 条命令')
  assert.equal(stepsSummary(tally({ counts }), en), 'Read 3 files, edited 1 file, ran 2 commands')
  assert.equal(
    stepsSummary(
      tally({
        counts: [
          { kind: 'search', n: 1 },
          { kind: 'add', n: 2 },
          { kind: 'tool', n: 4 },
          { kind: 'web', n: 1 },
          { kind: 'list', n: 1 },
          { kind: 'delete', n: 1 },
        ],
      }),
      zh,
    ),
    '搜索 1 次，新增 2 个文件，调用 4 次工具，查询网页 1 次，列出 1 个目录，删除 1 个文件',
  )
  // 英文开头那段大写
  assert.equal(stepsSummary(tally({ counts: [{ kind: 'command', n: 1 }] }), en), 'Ran 1 command')
})

test('步骤组：只有思考的写“已思考”；只有一条提示的写那条提示', () => {
  assert.equal(stepsSummary(tally({ thoughts: 2 }), zh), '已思考')
  assert.equal(stepsSummary(tally({ thoughts: 1 }), en), 'Thought')
  const notice = tally({ counts: [{ kind: 'notice', n: 1 }], notice: '上下文已压缩' })
  assert.equal(stepsSummary(notice, zh), '上下文已压缩')
  const notices = tally({ counts: [{ kind: 'notice', n: 2 }], notice: '上下文已压缩' })
  assert.equal(stepsSummary(notices, zh), '2 条提示')
})

test('正在跑的那一条：动词按动作，对象是命令、文件名、工具名后半截', () => {
  const command = { id: 'c', kind: 'command', command: 'go vet ./...', status: 'inProgress' }
  assert.deepEqual(nowOf(command, 'command', zh), {
    label: '正在运行',
    target: 'go vet ./...',
  })
  const read = { id: 'r', kind: 'toolCall', tool: 'Read src/a.ts', source: 'claude-code' }
  assert.deepEqual(nowOf(read, 'read', zh), {
    label: '正在读取',
    target: 'src/a.ts',
  })
  const mcp = { id: 'm', kind: 'toolCall', tool: 'click', source: 'browser' }
  assert.deepEqual(nowOf(mcp, 'tool', zh), {
    label: '正在调用',
    target: 'browser · click',
  })
  const edit = {
    id: 'f',
    kind: 'fileChange',
    changes: [{ path: 'cmd/serve.go', change: 'update' }],
  }
  assert.deepEqual(nowOf(edit, 'update', zh), { label: '正在修改', target: 'serve.go' })
  // 给别的会话发消息（Claude Code 的“SendMessage 收件人”）：对象是收件人
  const send = { id: 's', kind: 'toolCall', tool: 'SendMessage 修 CI', source: 'claude-code' }
  assert.deepEqual(nowOf(send, 'message', zh), { label: '正在发消息给', target: '修 CI' })
  assert.equal(stepsSummary(tally({ counts: [{ kind: 'message', n: 2 }] }), zh), '发送 2 条消息')
  assert.equal(stepsSummary(tally({ counts: [{ kind: 'message', n: 1 }] }), en), 'Sent 1 message')
})

test('发消息给收件箱地址：认出了写名字，认不出写“另一个 Claude 会话”加进程号，不露套接字路径', () => {
  const uds = 'SendMessage uds:/tmp/cc-socks/887369.sock'
  const named = {
    id: 's',
    kind: 'toolCall',
    tool: 'SendMessage 修 CI',
    source: 'claude-code',
    peer: { name: '修 CI', session: null, thread: 'thread-9', bypass: false },
  }
  assert.equal(messageTarget(named, zh), '修 CI')
  // 名字以入口认出来的为准（tool 里还是地址时也一样）
  assert.equal(messageTarget({ ...named, tool: uds }, zh), '修 CI')
  const bare = { id: 's', kind: 'toolCall', tool: uds, source: 'claude-code' }
  assert.equal(messageTarget(bare, zh), '另一个 Claude 会话（进程 887369）')
  assert.equal(messageTarget(bare, en), 'another Claude session (process 887369)')
  assert.deepEqual(nowOf(bare, 'message', zh), {
    label: '正在发消息给',
    target: '另一个 Claude 会话（进程 887369）',
  })
  const odd = { ...bare, tool: 'SendMessage uds:/run/cc/inbox' }
  assert.equal(messageTarget(odd, zh), '另一个 Claude 会话')
  // 按名字发的、发给子代理的照原样
  assert.equal(
    messageTarget({ ...bare, tool: 'SendMessage deadbeefcafef00d' }, zh),
    'deadbeefcafef00d',
  )
})

test('在想的时候：汇总行不写动词，只有思考的头一行（“正在工作”只在回合末尾那一行写）', () => {
  const think = { id: 't', kind: 'reasoning', text: '先拆两步\n再补测试', status: 'inProgress' }
  assert.deepEqual(nowOf(think, null, zh), { label: '', target: '先拆两步' })
  assert.deepEqual(nowOf(think, null, en), { label: '', target: '先拆两步' })
})

test('整段过程收成的一行：已处理多久、几段说明、几步、几个子代理；被拒、出错另列，失败的步骤不数', () => {
  const full = { notes: 3, steps: 18, agents: 2, failed: 1, declined: 2, agentsFailed: 1 }
  assert.deepEqual(processSummary(full, '4 分 12 秒', zh, null), {
    plain: ['已处理 4 分 12 秒', '3 段说明', '18 步', '2 个子代理'],
    bad: ['2 条被拒', '1 个子代理失败'],
  })
  const bare = { notes: 0, steps: 4, agents: 0, failed: 0, declined: 0, agentsFailed: 0 }
  assert.deepEqual(processSummary(bare, null, zh, 'interrupted'), {
    plain: ['已处理', '4 步'],
    bad: ['已中断'],
  })
  assert.deepEqual(processSummary(bare, '38 秒', zh, 'failed').bad, ['出错'])
  assert.deepEqual(processSummary(full, '3s', en, null).plain, [
    'Worked for 3s',
    '3 notes',
    '18 steps',
    '2 subagents',
  ])
})
