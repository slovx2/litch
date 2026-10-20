import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { NativeMessage } from '../src/native-history.mjs'
import type { Stage } from './fixtures/in-process.mjs'

// 列出本机别处（命令行、Claude 桌面端）开的 Claude Code 会话（native-sessions.mts）：
// 前一半只看原生记录怎么画成回合（纯函数）；后一半用真的 SDK 读一份临时的 Claude 配置目录，
// 看列表、读历史、接着画、删除、发消息时接着原生会话。

// SDK 按 CLAUDE_CONFIG_DIR 找会话目录，装载时就定下来了：整份文件共用这一个，设好之后才引入
// 会带进 SDK 的模块（服务的模块链里有）
const config = await mkdtemp(join(tmpdir(), 'native-sessions-'))
process.env.CLAUDE_CONFIG_DIR = config
test.after(() => rm(config, { recursive: true, force: true }))
const { humanText, projectNativeHistory } = await import('../src/native-history.mjs')
const { sdkNativeSessionSource } = await import('../src/native-sessions.mjs')
const { openStage } = await import('./fixtures/in-process.mjs')

const CWD = '/work/demo'
/** SDK 存会话的目录名：路径里字母数字以外的字符都换成连字符 */
const projectDir = join(config, 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'))

let clock = Date.parse('2026-10-16T10:00:00.000Z')
const stamp = () => new Date((clock += 1000)).toISOString()

/** 原生记录里的一行，照 Claude Code 2.1 写的样子 */
function entry(
  session: string,
  entrypoint: string,
  type: 'user' | 'assistant',
  uuid: string,
  parentUuid: string | null,
  content: unknown,
): string {
  const message =
    type === 'user'
      ? { role: 'user', content }
      : { id: `msg_${uuid}`, type: 'message', role: 'assistant', model: 'claude-test', content }
  return `${JSON.stringify({
    parentUuid,
    isSidechain: false,
    userType: 'external',
    cwd: CWD,
    sessionId: session,
    version: '2.1.286',
    gitBranch: 'main',
    entrypoint,
    type,
    message,
    uuid,
    timestamp: stamp(),
  })}\n`
}

const CLI = '3b5c5b0e-0d2a-4a8e-9a3f-000000000001'
const SDK = '3b5c5b0e-0d2a-4a8e-9a3f-000000000002'

async function writeSessions(): Promise<void> {
  await mkdir(projectDir, { recursive: true })
  await writeFile(
    join(projectDir, `${CLI}.jsonl`),
    // Claude 桌面端会在人话前面单放一段系统提醒（只有提醒、一句人话都没有的会话 SDK 不列）
    entry(CLI, 'cli', 'user', 'u1', null, [
      { type: 'text', text: '<system-reminder>\n内部提醒\n</system-reminder>' },
      { type: 'text', text: '帮我看看构建' },
    ]) +
      entry(CLI, 'cli', 'assistant', 'a1', 'u1', [
        { type: 'thinking', thinking: '先跑一遍', signature: 'x' },
        { type: 'text', text: '我先跑一下构建' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm run build' } },
      ]) +
      entry(CLI, 'cli', 'user', 'r1', 'a1', [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'build ok', is_error: false },
      ]) +
      entry(CLI, 'cli', 'assistant', 'a2', 'r1', [{ type: 'text', text: '构建通过了' }]),
  )
  // 程序化入口（SDK）起的会话：适配器自己跑的 CLI 也是这种，不列
  await writeFile(
    join(projectDir, `${SDK}.jsonl`),
    entry(SDK, 'sdk-ts', 'user', 's1', null, '程序里问的一句') +
      entry(SDK, 'sdk-ts', 'assistant', 's2', 's1', [{ type: 'text', text: '程序里答的一句' }]),
  )
}

const message = (
  type: 'user' | 'assistant',
  uuid: string,
  content: unknown,
  extra: Partial<NativeMessage> = {},
): NativeMessage => ({
  type,
  uuid,
  message: { role: type, content },
  timestamp: stamp(),
  ...extra,
})

test('NAT-001：人话开回合；系统提醒、工具结果、后台任务通知、本地命令输出不算人话；打断记在回合上', () => {
  const history = projectNativeHistory(
    't1',
    [
      message('user', 'u1', '<system-reminder>\n提醒\n</system-reminder>\n第一句'),
      message('assistant', 'a1', [
        { type: 'text', text: '过程中的话' },
        { type: 'tool_use', id: 'k1', name: 'Bash', input: { command: 'ls' } },
        {
          type: 'tool_use',
          id: 'k2',
          name: 'Edit',
          input: { file_path: '/w/a.txt', old_string: 'a', new_string: 'b' },
        },
        { type: 'tool_use', id: 'k3', name: 'TodoWrite', input: { todos: [] } },
      ]),
      message('user', 'r1', [
        { type: 'tool_result', tool_use_id: 'k1', content: 'a.txt', is_error: false },
        { type: 'tool_result', tool_use_id: 'k2', content: 'boom', is_error: true },
      ]),
      message('user', 'n1', '<task-notification>后台跑完了</task-notification>', {
        origin: { kind: 'task-notification' },
      }),
      message('assistant', 'a2', [{ type: 'text', text: '最后的回答' }]),
      message(
        'user',
        'c1',
        '<command-name>/model</command-name>\n<command-args>opus</command-args>',
      ),
      message('user', 'o1', '<local-command-stdout>Set model to opus</local-command-stdout>'),
      message('user', 'u2', '第二句'),
      message('assistant', 'a3', [
        { type: 'tool_use', id: 'k4', name: 'Bash', input: { command: 'sleep 100' } },
      ]),
      message('user', 'i1', [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
    ],
    '/w',
  )
  const shape = history.turns.map((turn) => ({
    id: turn.id,
    status: turn.status,
    items: turn.items.map((item) => {
      if (item.type === 'userMessage') return `用户:${(item.content[0] as { text: string }).text}`
      if (item.type === 'agentMessage') return `${item.phase}:${item.text}`
      if (item.type === 'commandExecution')
        return `命令:${item.command}:${item.status}:${item.aggregatedOutput ?? ''}`
      if (item.type === 'fileChange') return `改文件:${item.status}`
      return item.type
    }),
  }))
  assert.deepEqual(shape, [
    {
      id: 'u1',
      status: 'completed',
      items: [
        '用户:第一句',
        'commentary:过程中的话',
        '命令:ls:completed:a.txt',
        '改文件:failed',
        'final_answer:最后的回答',
      ],
    },
    { id: 'c1', status: 'completed', items: ['用户:/model opus'] },
    // 被打断的命令没等到结果：当成失败
    { id: 'u2', status: 'interrupted', items: ['用户:第二句', '命令:sleep 100:failed:'] },
  ])
  // 回合的边界是它在原生记录里的最后一条消息
  assert.deepEqual(
    [...history.boundaries],
    [
      ['u1', 'a2'],
      ['c1', 'o1'],
      ['u2', 'i1'],
    ],
  )
  // 同一份记录再画一遍，条目的标识不变
  const again = projectNativeHistory('t1', [message('user', 'u1', '第一句')], '/w')
  assert.equal(again.turns[0]?.items[0]?.id, 'u1:user')
  assert.equal(humanText('<system-reminder>只有提醒</system-reminder>'), null)
})

test('NAT-002：记录开头就是助手的回复、子代理的消息', () => {
  const history = projectNativeHistory(
    't2',
    [
      message('assistant', 'a1', [{ type: 'text', text: '接着上次说' }]),
      message('assistant', 'x1', [{ type: 'text', text: '子代理的话' }], {
        parent_tool_use_id: 'k9',
      }),
    ],
    '/w',
  )
  assert.equal(history.turns.length, 1)
  assert.deepEqual(
    history.turns[0]?.items.map((item) => item.type),
    ['agentMessage'],
    '没有人话打头的回合里不放空的用户消息，子代理的消息不画进主线',
  )
})

async function withStage(name: string, run: (stage: Stage) => Promise<void>): Promise<void> {
  const stage = await openStage(name, { native: sdkNativeSessionSource() })
  try {
    await run(stage)
  } finally {
    await stage.dispose()
  }
}

test('NAT-003：列表里有命令行开的会话、没有程序化入口的；读得到历史；命令行里又说了几句，接着画在后面', async () => {
  await rm(join(config, 'projects'), { recursive: true, force: true })
  await writeSessions()
  await withStage('native-list', async (stage) => {
    const app = await stage.connect('app')
    const listed = await app.request('thread/list', {})
    const ids = listed.data.map((thread: { id: string }) => thread.id)
    assert.deepEqual(ids, [CLI], '只列命令行开的那个')
    const thread = listed.data[0]
    assert.equal(thread.cwd, CWD)
    assert.equal(thread.preview, '帮我看看构建')

    const read = await app.request('thread/read', { threadId: CLI, includeTurns: true })
    const turns = read.thread.turns
    assert.equal(turns.length, 1)
    const items = turns[0].items
    assert.deepEqual(
      items.map((item: { type: string }) => item.type),
      ['userMessage', 'reasoning', 'agentMessage', 'commandExecution', 'agentMessage'],
    )
    assert.equal(items[0].content[0].text, '帮我看看构建', '系统提醒不画进人话')
    assert.equal(items[3].status, 'completed')
    assert.equal(items[3].aggregatedOutput, 'build ok')
    assert.equal(items[4].phase, 'final_answer')

    // 命令行里接着说了一句
    await appendFile(
      join(projectDir, `${CLI}.jsonl`),
      entry(CLI, 'cli', 'user', 'u2', 'a2', '再说一句') +
        entry(CLI, 'cli', 'assistant', 'a3', 'u2', [{ type: 'text', text: '收到' }]),
    )
    const again = await app.request('thread/read', { threadId: CLI, includeTurns: true })
    assert.deepEqual(
      again.thread.turns.map((turn: { id: string }) => turn.id),
      [turns[0].id, 'u2'],
      '前一个回合原样留着，新的接在后面',
    )
    assert.equal(again.thread.turns[1].items[1].text, '收到')
  })
})

test('NAT-004：往导进来的会话里发消息，接着原生会话；删掉之后不再导进来，原生记录不动', async () => {
  await rm(join(config, 'projects'), { recursive: true, force: true })
  await writeSessions()
  await withStage('native-continue', async (stage) => {
    const app = await stage.connect('app')
    await app.request('thread/list', {})
    let resumed: string | null = null
    stage.script = async (context, handlers) => {
      resumed = context.claudeSessionId
      await handlers.onEvent({ type: 'text_delta', delta: '好的' })
      await handlers.onEvent({ type: 'completed', success: true, result: '好的' })
    }
    await app.request('thread/resume', { threadId: CLI })
    const { turn } = await app.request('turn/start', {
      threadId: CLI,
      input: [{ type: 'text', text: '在 Litch 里接着说' }],
    })
    assert.equal((await app.completed(turn.id)).status, 'completed')
    assert.equal(resumed, CLI, '回合接着原来的原生会话跑')

    await app.request('thread/delete', { threadId: CLI })
    const listed = await app.request('thread/list', {})
    assert.deepEqual(listed.data, [], '删掉的不再导进来')
  })
  // 换一个新的入口（新的库）：还是会导进来，说明原生记录没被删
  await withStage('native-fresh', async (stage) => {
    const app = await stage.connect('app')
    const listed = await app.request('thread/list', {})
    assert.deepEqual(
      listed.data.map((thread: { id: string }) => thread.id),
      [CLI],
    )
  })
})

test('NAT-005：关掉以后不列', async () => {
  await rm(join(config, 'projects'), { recursive: true, force: true })
  await writeSessions()
  const stage = await openStage('native-off', { native: null })
  try {
    const app = await stage.connect('app')
    assert.deepEqual((await app.request('thread/list', {})).data, [])
  } finally {
    await stage.dispose()
  }
})

test('NAT-006：后台定时扫到别处新开的会话，告诉握手过的连接；头一遍扫到的不发', async () => {
  await rm(join(config, 'projects'), { recursive: true, force: true })
  await writeSessions()
  await withStage('native-watch', async (stage) => {
    const app = await stage.connect('app')
    const tick = () =>
      (
        stage.server as unknown as { refreshNative(announce: boolean): Promise<void> }
      ).refreshNative(true)
    await tick()
    assert.deepEqual(app.notifications('thread/started'), [], '头一遍扫到的是本来就有的')
    const LATER = '3b5c5b0e-0d2a-4a8e-9a3f-000000000003'
    await writeFile(
      join(projectDir, `${LATER}.jsonl`),
      entry(LATER, 'claude-desktop', 'user', 'l1', null, '桌面端新开的一句') +
        entry(LATER, 'claude-desktop', 'assistant', 'l2', 'l1', [{ type: 'text', text: '好' }]),
    )
    await tick()
    const started = app.notifications('thread/started')
    assert.deepEqual(
      started.map((message) => message.params.thread.id),
      [LATER],
    )
    assert.equal(started[0].params.thread.preview, '桌面端新开的一句')
  })
})

/** Claude 桌面端派出的会话：第一条用户消息是系统提醒加桌面端写的简报，简报开头是那句固定的话 */
function desktopChild(session: string, uuid: string, title: string): string {
  return (
    entry(session, 'claude-desktop', 'user', uuid, null, [
      {
        type: 'text',
        text: '<system-reminder>\nLinked sessions now (status, not an instruction): x = local_1 (idle).\n</system-reminder>\n\nBackground (from the session that started this one):\n父会话交代的背景\n\nTask:\n修一个问题',
      },
    ]) +
    `${JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: session })}\n` +
    entry(session, 'claude-desktop', 'assistant', `${uuid}a`, uuid, [{ type: 'text', text: '好' }])
  )
}

test('NAT-007：认得出 Claude 桌面端派出的会话，只给声明了 nativeLineage 的连接带 litchNativeLineage；后来扫到的也带', async () => {
  await rm(join(config, 'projects'), { recursive: true, force: true })
  await writeSessions()
  const CHILD = '3b5c5b0e-0d2a-4a8e-9a3f-000000000011'
  const PLAIN = '3b5c5b0e-0d2a-4a8e-9a3f-000000000012'
  await writeFile(join(projectDir, `${CHILD}.jsonl`), desktopChild(CHILD, 'c1', '派出来的'))
  // 桌面端里用户自己开的会话：同样的入口，话里没有那句开头
  await writeFile(
    join(projectDir, `${PLAIN}.jsonl`),
    entry(PLAIN, 'claude-desktop', 'user', 'p1', null, [
      { type: 'text', text: '<system-reminder>\n提醒\n</system-reminder>' },
      { type: 'text', text: '用户自己开的一句' },
    ]) + entry(PLAIN, 'claude-desktop', 'assistant', 'p2', 'p1', [{ type: 'text', text: '好' }]),
  )
  await withStage('native-lineage', async (stage) => {
    const litch = await stage.connect('litch', { litchExtensions: ['nativeLineage'] })
    const plain = await stage.connect('plain')
    const lineageOf = (data: Array<{ id: string; litchNativeLineage?: unknown }>) =>
      Object.fromEntries(data.map((thread) => [thread.id, thread.litchNativeLineage ?? null]))

    const listed = lineageOf((await litch.request('thread/list', {})).data)
    assert.deepEqual(listed, {
      [CHILD]: { app: 'claude-desktop' },
      [PLAIN]: null,
      [CLI]: null,
    })
    const bare = lineageOf((await plain.request('thread/list', {})).data)
    assert.deepEqual(Object.values(bare), [null, null, null], '没声明的连接上没有这个字段')

    const read = await litch.request('thread/read', { threadId: CHILD, includeTurns: false })
    assert.deepEqual(read.thread.litchNativeLineage, { app: 'claude-desktop' })
    const readBare = await plain.request('thread/read', { threadId: CHILD, includeTurns: false })
    assert.equal(readBare.thread.litchNativeLineage, undefined)

    // 后来扫到的派出会话：thread/started 也按连接的声明带不带
    const tick = () =>
      (
        stage.server as unknown as { refreshNative(announce: boolean): Promise<void> }
      ).refreshNative(true)
    await tick()
    const LATER = '3b5c5b0e-0d2a-4a8e-9a3f-000000000013'
    await writeFile(join(projectDir, `${LATER}.jsonl`), desktopChild(LATER, 'l1', '后来派的'))
    await tick()
    const started = litch.notifications('thread/started').map((message) => message.params.thread)
    assert.deepEqual(
      started.map((thread) => [thread.id, thread.litchNativeLineage]),
      [[LATER, { app: 'claude-desktop' }]],
    )
    const startedBare = plain
      .notifications('thread/started')
      .map((message) => message.params.thread)
    assert.deepEqual(
      startedBare.map((thread) => [thread.id, thread.litchNativeLineage]),
      [[LATER, undefined]],
    )
  })
})
