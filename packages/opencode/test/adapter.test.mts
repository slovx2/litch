import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { OpencodeServer } from '../src/server.mjs'
import { client, isolate, skip, text, violations } from './client.mjs'
import { scripted } from './mock-model.mjs'

// 回放比较时去掉只在直播里才准的时间字段
const shape = (turn: any) => ({
  id: turn.id,
  status: turn.status,
  error: turn.error,
  items: turn.items,
})

// 真实的 opencode serve 对着回环假模型：一轮里有思考、逐字输出、命令（审批、输出增量）、改文件（审批、差异）、
// 待办和用量；第二轮拒绝命令并附说明，模型接着回答；之后重开适配器，从 OpenCode 读回历史，回放和直播一致。
test('OpenCode：逐字流、命令与改文件审批、待办、差异、用量、拒绝附说明、历史回放', {
  skip,
  timeout: 180000,
}, async () => {
  const env = await isolate(
    scripted({
      FIRST: [
        [
          { type: 'reasoning', text: '先跑个命令。' },
          { type: 'text', chunks: ['逐', '字', '输', '出'], delayMs: 40 },
          {
            type: 'tool',
            name: 'bash',
            input: { command: 'printf one; sleep 1; printf two', description: '打印两段' },
          },
        ],
        [
          {
            type: 'tool',
            name: 'edit',
            input: { filePath: 'a.txt', oldString: 'hello', newString: 'world' },
          },
        ],
        [
          {
            type: 'tool',
            name: 'todowrite',
            input: {
              todos: [
                { content: '改文件', status: 'completed', priority: 'high' },
                { content: '收尾', status: 'in_progress', priority: 'low' },
              ],
            },
          },
        ],
        [{ type: 'text', chunks: ['第一轮完成。'] }],
      ],
      SECOND: [
        [
          {
            type: 'tool',
            name: 'bash',
            input: { command: 'echo no > denied.txt', description: '会被拒绝' },
          },
        ],
        [{ type: 'text', chunks: ['好，不写了。'] }],
      ],
    }),
    { permission: { bash: 'ask', edit: 'ask' }, files: { 'a.txt': 'hello\n' } },
  )
  let second: OpencodeServer | null = null
  try {
    const desktop = client(env.server, ['declineWithNote'])
    await desktop.initialize()
    const models = await desktop.call('model/list', {})
    const mock = models.data.find((entry: any) => entry.id === 'mock/m1')
    assert.ok(mock, '假模型在清单里')
    assert.equal(mock.isDefault, true)
    assert.deepEqual(
      mock.supportedReasoningEfforts.map((entry: any) => entry.reasoningEffort),
      ['default', 'low', 'medium', 'high'],
    )

    const started = await desktop.call('thread/start', { cwd: env.cwd, permissions: ':workspace' })
    const threadId = started.thread.id
    assert.match(threadId, /^ses_/)
    assert.equal(started.model, 'mock/m1')
    assert.equal(started.activePermissionProfile.id, ':workspace')
    assert.deepEqual((await desktop.call('thread/list', {})).data, [], '空白会话不进列表')

    desktop.onRequest((request) => {
      if (request.method === 'item/commandExecution/requestApproval') {
        if (request.params.command.includes('denied'))
          return { decision: { declineWithNote: { note: '别写这个文件' } } }
        return { decision: 'accept' }
      }
      if (request.method === 'item/fileChange/requestApproval') return { decision: 'accept' }
      return {}
    })
    const turn = await desktop.call('turn/start', {
      threadId,
      input: text('FIRST 请开始'),
      clientUserMessageId: 'client-1',
    })
    const turnId = turn.turn.id
    assert.match(turnId, /^msg_/)
    const completed = (await desktop.until('turn/completed', (p) => p.turn.id === turnId, 60000))
      .turn
    assert.equal(completed.status, 'completed', JSON.stringify(completed.error))
    assert.deepEqual(
      completed.items.map((item: any) => item.type),
      [
        'userMessage',
        'reasoning',
        'agentMessage',
        'commandExecution',
        'fileChange',
        'agentMessage',
      ],
    )
    const [user, reasoning, commentary, command, change, answer] = completed.items
    assert.equal(user.id, turnId)
    assert.equal(user.clientId, 'client-1')
    assert.deepEqual(user.content, text('FIRST 请开始'))
    assert.deepEqual(reasoning.summary, ['先跑个命令。'])
    assert.equal(commentary.text, '逐字输出')
    assert.equal(commentary.phase, 'commentary')
    assert.equal(answer.phase, 'final_answer')
    assert.equal(answer.text, '第一轮完成。')
    assert.ok(
      desktop.of('item/agentMessage/delta', threadId).filter((p) => p.itemId === commentary.id)
        .length >= 2,
      '逐字到达',
    )
    assert.equal(command.status, 'completed')
    assert.equal(command.exitCode, 0)
    assert.equal(command.aggregatedOutput, 'onetwo')
    const outputs = desktop
      .of('item/commandExecution/outputDelta', threadId)
      .filter((p) => p.itemId === command.id)
    assert.equal(outputs.map((p) => p.delta).join(''), 'onetwo')
    assert.ok(outputs.length >= 2, '命令输出分段到达')
    assert.equal(change.status, 'completed')
    assert.equal(change.changes[0].path, join(env.cwd, 'a.txt'))
    assert.match(change.changes[0].diff, /-hello\n\+world/)
    assert.equal(await readFile(join(env.cwd, 'a.txt'), 'utf8'), 'world\n')

    const approvals = desktop.requests.map((request) => request.method)
    assert.deepEqual(approvals, [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
    ])
    assert.equal(desktop.requests[0].params.itemId, command.id)
    assert.equal(desktop.requests[1].params.itemId, change.id)
    assert.equal(desktop.of('serverRequest/resolved', threadId).length, 2)

    const plan = desktop.of('turn/plan/updated', threadId).at(-1)
    assert.deepEqual(plan.plan, [
      { step: '改文件', status: 'completed' },
      { step: '收尾', status: 'inProgress' },
    ])
    const diff = desktop.of('turn/diff/updated', threadId).at(-1)
    assert.match(diff.diff, /^diff --git a\/a\.txt b\/a\.txt\n--- a\/a\.txt\n\+\+\+ b\/a\.txt\n@@/)
    const usage = desktop.of('thread/tokenUsage/updated', threadId).at(-1)
    assert.equal(usage.tokenUsage.modelContextWindow, 100000)
    // 每一步 120 输入（其中 20 命中缓存）30 输出，这一轮四步
    assert.equal(usage.tokenUsage.total.inputTokens, 480)
    assert.equal(usage.tokenUsage.total.cachedInputTokens, 80)
    assert.equal(usage.tokenUsage.last.totalTokens, 150)

    const listed = await desktop.call('thread/list', {})
    assert.deepEqual(
      listed.data.map((thread: any) => thread.id),
      [threadId],
    )
    assert.equal(listed.data[0].preview, 'FIRST 请开始')

    // 第二轮：命令被拒并附说明，说明交给模型，模型接着回答，回合正常结束
    const next = await desktop.call('turn/start', { threadId, input: text('SECOND 再来') })
    const done = (await desktop.until('turn/completed', (p) => p.turn.id === next.turn.id, 60000))
      .turn
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const denied = done.items.find((item: any) => item.type === 'commandExecution')
    assert.equal(denied.status, 'declined')
    assert.equal(done.items.at(-1).text, '好，不写了。')
    const asked = desktop.requests.at(-1)
    assert.ok(asked.params.availableDecisions.includes('declineWithNote'))
    const sent = env.model.requests.at(-1)
    assert.ok(JSON.stringify(sent.messages).includes('别写这个文件'), '说明交给了模型')

    // 重开适配器（新的 serve 进程），历史从 OpenCode 读回来
    await env.server.close()
    second = new OpencodeServer(env.home)
    const again = client(second)
    await again.initialize()
    const resumed = await again.call('thread/resume', { threadId })
    assert.deepEqual(resumed.thread.turns.map(shape), [completed, done].map(shape))
    assert.equal(resumed.thread.preview, 'FIRST 请开始')
    const read = await again.call('thread/read', { threadId, includeTurns: false })
    assert.deepEqual(read.thread.turns, [])
  } finally {
    await second?.close().catch(() => {})
    await env.restore()
  }
  assert.deepEqual([...violations], [])
})
