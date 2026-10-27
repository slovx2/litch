import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BackgroundCommands, endedCommandItem } from '../src/background-commands.mjs'
import {
  backgroundCommandEnd,
  goalReminder,
  isMainToolResult,
  keepAliveIdleMs,
  keepAliveLimit,
  liveContext,
  needsStrictSkillShell,
  notificationFolded,
  notificationGraceLeft,
  resultConfirms,
  sessionFingerprint,
  startsRound,
  steerMessage,
  userMessage,
} from '../src/native-session.mjs'
import type { RuntimeTurnContext, ThreadItem } from '../src/types.mjs'

function context(overrides: Partial<RuntimeTurnContext> = {}): RuntimeTurnContext {
  return {
    threadId: 'thread',
    turnId: 'turn',
    prompt: 'hello',
    cwd: '/workspace',
    runtimeType: null,
    model: null,
    effort: null,
    claudeSessionId: null,
    forkSession: false,
    mcpServers: null,
    allowedTools: null,
    addDirs: [],
    outputFormat: null,
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    systemPromptAddendum: null,
    planMode: false,
    imageInputs: [],
    ...overrides,
  }
}

test('回合归属：按用户消息 ID 确认 result，不按 result 的来源', () => {
  // 探针录下的三种形态：用户那一轮、通知触发的那一轮、用户消息被并进通知那一轮。
  const human = { origin: { kind: 'human' }, user_message_uuid: 'u1', user_message_uuids: ['u1'] }
  const notification = { origin: { kind: 'task-notification', producer: 'session-task' } }
  const folded = { origin: { kind: 'task-notification' }, user_message_uuids: ['u0', 'u1'] }
  assert.equal(resultConfirms(human, 'u1'), true)
  assert.equal(resultConfirms(notification, 'u1'), false)
  assert.equal(resultConfirms(folded, 'u1'), true)
  assert.equal(resultConfirms(human, 'u2'), false)
})

test('没有回合时：一轮的开头与实际输出算 CLI 自己开了一轮，静默消息的空 result 不算', () => {
  assert.equal(startsRound({ type: 'system', subtype: 'init' }), true)
  assert.equal(startsRound({ type: 'stream_event' }), true)
  assert.equal(startsRound({ type: 'assistant' }), true)
  assert.equal(startsRound({ type: 'result', subtype: 'success', num_turns: 1 }), true)
  assert.equal(startsRound({ type: 'result', subtype: 'error_during_execution' }), true)
  // 适配器送入不触发模型请求的消息：running → 空 result → idle。
  assert.equal(startsRound({ type: 'system', subtype: 'session_state_changed' }), false)
  assert.equal(startsRound({ type: 'result', subtype: 'success', num_turns: 0, result: '' }), false)
  // 停掉后台命令只有任务消息，没有新的一轮。
  assert.equal(startsRound({ type: 'system', subtype: 'task_notification' }), false)
  assert.equal(startsRound({ type: 'system', subtype: 'background_tasks_changed' }), false)
})

test('启动指纹：目标说明的变化不算，工作目录、工具与指令的变化算', () => {
  const goal = '当前用户授权的持续目标：\n写完报告\n已使用：10'
  const base = context({ systemPromptAddendum: `开发者指令\n\n${goal}`, goalContext: goal })
  const later = '当前用户授权的持续目标：\n写完报告\n已使用：99'
  const same = context({ systemPromptAddendum: `开发者指令\n\n${later}`, goalContext: later })
  assert.equal(sessionFingerprint(base), sessionFingerprint(same))
  assert.equal(
    sessionFingerprint(base),
    sessionFingerprint(context({ systemPromptAddendum: '开发者指令' })),
  )
  for (const changed of [
    context({ ...base, cwd: '/other' }),
    context({ ...base, systemPromptAddendum: `另一份指令\n\n${goal}` }),
    context({ ...base, mcpServers: { fixture: { command: 'node' } } }),
    context({ ...base, dynamicTools: [{ name: 'tool' }] }),
    context({ ...base, prompt: '/workflows run it' }),
    context({ ...base, goalTools: true }),
  ])
    assert.notEqual(sessionFingerprint(base), sessionFingerprint(changed))
  // 模型、推理强度、计划模式有运行期接口，不进指纹。
  assert.equal(
    sessionFingerprint(base),
    sessionFingerprint(context({ ...base, model: 'opus', effort: 'low', planMode: true })),
  )
})

test('权限从宽变严需要重启：受限会话必须关闭 Skill 的内联 shell', () => {
  assert.equal(needsStrictSkillShell(context()), false)
  assert.equal(needsStrictSkillShell(context({ planMode: true })), true)
  assert.equal(needsStrictSkillShell(context({ approvalPolicy: 'on-request' })), true)
  assert.equal(needsStrictSkillShell(context({ sandboxMode: 'workspace-write' })), true)
})

test('目标变化随用户消息告诉模型；斜杠命令保持纯文本', () => {
  assert.equal(goalReminder(null, null), null)
  assert.equal(goalReminder('目标甲', '目标甲'), null)
  assert.match(String(goalReminder('目标甲', '目标乙')), /目标乙/)
  assert.match(String(goalReminder('目标甲', null)), /不再生效/)

  const plain = userMessage(context(), null, null)
  assert.equal(plain.message.content, 'hello')
  assert.equal('uuid' in plain, false)
  const reminded = userMessage(context(), 'u-1-2-3-4', '<system-reminder>目标</system-reminder>')
  assert.equal(reminded.uuid, 'u-1-2-3-4')
  assert.deepEqual(reminded.message.content, [
    { type: 'text', text: '<system-reminder>目标</system-reminder>' },
    { type: 'text', text: 'hello' },
  ])
  const command = userMessage(context({ prompt: '/compact' }), 'u-1-2-3-4', '<system-reminder/>')
  assert.equal(command.message.content, '/compact')
  // 前面带空白（换行、空格）的也是命令：不带提醒，前面的空白去掉（进程里头一条以外的消息 CLI 不去空白）
  for (const prompt of ['\n/compact', '  /compact\n', '\t/compact'])
    assert.equal(
      userMessage(context({ prompt }), 'u-1-2-3-4', '<system-reminder/>').message.content,
      prompt.trimStart(),
    )
  assert.equal(
    userMessage(context({ prompt: '  不是命令' }), null, null).message.content,
    '  不是命令',
  )
})

test('带图片的斜杠命令排在图片后面：CLI 只拿最后一块文本去认命令', () => {
  const imageInputs = [
    { kind: 'base64' as const, mediaType: 'image/png', data: 'AAAA', displayPath: '/w/a.png' },
    { kind: 'url' as const, mediaType: 'image/png', data: 'https://x/b.png', displayPath: 'b' },
  ]
  const blocks = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'image', source: { type: 'url', url: 'https://x/b.png' } },
  ]
  // 选了技能又带图片：命令排在图片前面的话 CLI 不展开它，原样当成一句话发给模型
  assert.deepEqual(
    userMessage(context({ prompt: '/notes\n看一下 这张图', imageInputs }), null, null).message
      .content,
    [...blocks, { type: 'text', text: '/notes\n看一下 这张图' }],
  )
  // 只有技能和图片
  assert.deepEqual(
    userMessage(context({ prompt: '/notes', imageInputs }), null, null).message.content,
    [...blocks, { type: 'text', text: '/notes' }],
  )
  // 命令不带目标提醒，带了图片也一样
  assert.deepEqual(
    userMessage(context({ prompt: '/notes', imageInputs }), 'u-1-2-3-4', '<system-reminder/>')
      .message.content,
    [...blocks, { type: 'text', text: '/notes' }],
  )
  // 不是命令的话照旧排在图片前面，提醒在最前
  assert.deepEqual(
    userMessage(context({ imageInputs }), 'u-1-2-3-4', '<system-reminder/>').message.content,
    [{ type: 'text', text: '<system-reminder/>' }, { type: 'text', text: 'hello' }, ...blocks],
  )
  // 只有图片
  assert.deepEqual(
    userMessage(context({ prompt: '', imageInputs }), null, null).message.content,
    blocks,
  )
})

test('插话：没图片是一句文字；带图片发成内容块，文字在前', () => {
  const image = { kind: 'base64' as const, mediaType: 'image/png', data: 'AAAA', displayPath: 'a' }
  const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
  assert.equal(steerMessage('看看', 'u-1').message.content, '看看')
  assert.deepEqual(steerMessage('看看', 'u-1', [image]).message.content, [
    { type: 'text', text: '看看' },
    block,
  ])
  assert.deepEqual(steerMessage('', 'u-1', [image]).message.content, [block])
  assert.equal(steerMessage('看看', 'u-1', [image]).uuid, 'u-1')
})

test('当前回合的视图：读写都落在会话当前的上下文上', () => {
  const first = context({ turnId: 'first' })
  const second = context({ turnId: 'second', planMode: true })
  const slot = { context: first }
  const live = liveContext(slot)
  assert.equal(live.turnId, 'first')
  live.trackGoalTools = true
  assert.equal(first.trackGoalTools, true)
  slot.context = second
  assert.equal(live.turnId, 'second')
  assert.equal(live.planMode, true)
  assert.equal(live.trackGoalTools, undefined)
})

test('后台命令的终态：退出码取自通知摘要，输出读任务的输出文件', async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-session-'))
  const file = join(home, 'task.output')
  await writeFile(file, 'line one\nline two\n')
  try {
    assert.deepEqual(
      backgroundCommandEnd(
        {
          task_id: 't1',
          status: 'completed',
          summary: 'Background command "x" completed (exit code 0)',
          output_file: file,
        },
        'toolu_1',
      ),
      {
        taskId: 't1',
        toolUseId: 'toolu_1',
        status: 'completed',
        exitCode: 0,
        output: 'line one\nline two\n',
      },
    )
    const failed = backgroundCommandEnd(
      { task_id: 't2', status: 'failed', summary: 'failed (exit code 3)', output_file: '' },
      null,
    )
    assert.deepEqual(
      [failed.status, failed.exitCode, failed.output, failed.toolUseId],
      ['failed', 3, '', null],
    )
    assert.equal(backgroundCommandEnd({ task_id: 't3', status: 'stopped' }, null).status, 'stopped')
    assert.equal(backgroundCommandEnd({ task_id: 't4', status: 'killed' }, null).status, 'stopped')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('后台命令条目表：按任务取出，随进程清空；条目状态与原生一致', () => {
  const table = new BackgroundCommands()
  table.add('thread', {
    taskId: 'a',
    threadId: 'thread',
    turnId: 'turn-1',
    itemId: 'item-a',
    startedAtMs: 1,
  })
  // 追问回合借用父线程的进程：表按进程所属的线程分组，条目记着自己所在的线程。
  table.add('thread', {
    taskId: 'b',
    threadId: 'child',
    turnId: 'turn-2',
    itemId: 'item-b',
    startedAtMs: 2,
  })
  assert.equal(table.isRunning('turn-1', 'item-a'), true)
  assert.equal(table.isRunning('turn-1', 'item-b'), false)
  assert.equal(table.take('thread', 'a')?.itemId, 'item-a')
  assert.equal(table.take('thread', 'a'), null)
  assert.equal(table.isRunning('turn-1', 'item-a'), false)
  assert.deepEqual(
    table.drain('thread').map((entry) => [entry.taskId, entry.threadId]),
    [['b', 'child']],
  )
  assert.deepEqual(table.list('thread'), [])

  const item: ThreadItem = {
    type: 'commandExecution',
    id: 'item-a',
    command: 'sleep 1',
    cwd: '/workspace',
    processId: 'claude:toolu_1',
    source: 'agent',
    status: 'inProgress',
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  }
  assert.deepEqual(
    endedCommandItem(item, { status: 'completed', exitCode: 0, output: 'ok\n' }, 1200),
    { ...item, status: 'completed', aggregatedOutput: 'ok\n', exitCode: 0, durationMs: 1200 },
  )
  // 被停止或随进程结束：与原生一致记为失败，退出码 -1。
  const stopped = endedCommandItem(item, { status: 'stopped', exitCode: null, output: '' }, 5)
  assert.deepEqual([stopped.type, (stopped as typeof item).status], ['commandExecution', 'failed'])
  assert.equal((stopped as typeof item).exitCode, -1)
})

test('结束通知之后要不要等它触发的那一轮：从通知到达起算，主循环的工具结果出现后不再等', () => {
  // 通知刚到就 idle：那一轮可能还没开始，接着等到满两秒为止。
  assert.equal(notificationGraceLeft(10_000, 10_002), 1_998)
  assert.equal(notificationGraceLeft(10_000, 11_500), 500)
  // 通知到达已久：它触发的那一轮要来早就来了。
  assert.equal(notificationGraceLeft(10_000, 12_000), 0)
  assert.equal(notificationGraceLeft(10_000, 60_000), 0)
  // 工具结果紧跟着通知出现时，通知可能还没进 CLI 的队列，不能当作已经处理。
  assert.equal(notificationFolded(10_000, 10_008), false)
  assert.equal(notificationFolded(10_000, 10_250), true)

  const toolResult = { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }
  const user = (extra: Record<string, unknown> = {}, content: unknown = [toolResult]) => ({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content },
    ...extra,
  })
  assert.equal(isMainToolResult(user()), true)
  // 子代理里的工具结果、重放的历史消息、普通用户消息都不算。
  assert.equal(isMainToolResult(user({ parent_tool_use_id: 'toolu_agent' })), false)
  assert.equal(isMainToolResult(user({ isReplay: true })), false)
  assert.equal(isMainToolResult(user({}, [{ type: 'text', text: '追加指令' }])), false)
  assert.equal(isMainToolResult(user({}, '纯文本')), false)
  assert.equal(isMainToolResult({ type: 'assistant', message: { content: [toolResult] } }), false)
})

test('空闲保留：没设时开着会话间消息留 1 小时、关着不留，按秒设，非法值当 0，过大的按 setTimeout 的上限', () => {
  const previous = process.env.CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS
  const inbox = process.env.CHA_CLAUDE_CROSS_SESSION_INBOX
  try {
    delete process.env.CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS
    delete process.env.CHA_CLAUDE_CROSS_SESSION_INBOX
    assert.equal(keepAliveIdleMs(), 60 * 60 * 1000)
    process.env.CHA_CLAUDE_CROSS_SESSION_INBOX = 'off'
    assert.equal(keepAliveIdleMs(), 0)
    // 明设的秒数不看收件箱
    process.env.CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS = '30'
    assert.equal(keepAliveIdleMs(), 30_000)
    delete process.env.CHA_CLAUDE_CROSS_SESSION_INBOX
    process.env.CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS = '30'
    assert.equal(keepAliveIdleMs(), 30_000)
    process.env.CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS = '0.5'
    assert.equal(keepAliveIdleMs(), 500)
    process.env.CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS = ' '
    assert.equal(keepAliveIdleMs(), 60 * 60 * 1000, '空白当没设')
    for (const raw of ['0', '-1', 'soon']) {
      process.env.CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS = raw
      assert.equal(keepAliveIdleMs(), 0, raw)
    }
    process.env.CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS = '1e12'
    assert.equal(keepAliveIdleMs(), 2 ** 31 - 1)
  } finally {
    if (inbox === undefined) delete process.env.CHA_CLAUDE_CROSS_SESSION_INBOX
    else process.env.CHA_CLAUDE_CROSS_SESSION_INBOX = inbox
    if (previous === undefined) delete process.env.CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS
    else process.env.CHA_CLAUDE_KEEP_ALIVE_IDLE_SECONDS = previous
  }
})

test('保留上限：默认 8，可用环境变量调整，0 表示不保留', () => {
  const previous = process.env.CHA_CLAUDE_KEEP_ALIVE_SESSIONS
  try {
    delete process.env.CHA_CLAUDE_KEEP_ALIVE_SESSIONS
    assert.equal(keepAliveLimit(), 8)
    process.env.CHA_CLAUDE_KEEP_ALIVE_SESSIONS = '0'
    assert.equal(keepAliveLimit(), 0)
    process.env.CHA_CLAUDE_KEEP_ALIVE_SESSIONS = '3'
    assert.equal(keepAliveLimit(), 3)
    process.env.CHA_CLAUDE_KEEP_ALIVE_SESSIONS = 'many'
    assert.equal(keepAliveLimit(), 8)
  } finally {
    if (previous === undefined) delete process.env.CHA_CLAUDE_KEEP_ALIVE_SESSIONS
    else process.env.CHA_CLAUDE_KEEP_ALIVE_SESSIONS = previous
  }
})
