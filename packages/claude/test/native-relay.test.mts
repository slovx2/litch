import assert from 'node:assert/strict'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Stage } from './fixtures/in-process.mjs'

// 在 Claude 桌面端和 Litch 之间接力同一个原生会话（报告 research/claude-relay-2026-10-21 第五节）：
// 别处的进程开着时只读（native-owner.mts）、导进来的会话画对（native-sessions.mts、native-history.mts）、
// 用量与设置从原生记录里取（native-record.mts）、停在会话上自动刷新（server.mts 的 followNative）。
// 原生记录和交互进程的登记都放在一个临时的 Claude 配置目录里，不碰真实的 ~/.claude。

// SDK 按 CLAUDE_CONFIG_DIR 找会话目录，装载时就定下来了：设好之后才引入会带进 SDK 的模块
const config = await mkdtemp(join(tmpdir(), 'native-relay-'))
process.env.CLAUDE_CONFIG_DIR = config
const { HALF_DRAWN } = await import('./fixtures/native-half-drawn.mjs')
const { NativeOwners } = await import('../src/native-owner.mjs')
const { nativeRecordFacts } = await import('../src/native-record.mjs')
const { sdkNativeSessionSource } = await import('../src/native-sessions.mjs')
const { openStage } = await import('./fixtures/in-process.mjs')

const CWD = '/work/relay'
const projectDir = join(config, 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'))
const registry = join(config, 'sessions')
const id = (n: number) => `3b5c5b0e-0d2a-4a8e-9a3f-0000000002${String(n).padStart(2, '0')}`
const record = (session: string) => join(projectDir, `${session}.jsonl`)

const children: ChildProcess[] = []
test.after(async () => {
  for (const child of children) child.kill('SIGKILL')
  await rm(config, { recursive: true, force: true })
})

/** 一个真活着的进程，当作 Claude 桌面端起的 CLI */
async function liveProcess(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
  children.push(child)
  await once(child, 'spawn')
  return child
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

/** 照 CLI 的取法拿进程的启动时间 */
const lstart = (pid: number) =>
  execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  }).trim()

/** 交互进程的登记：<配置目录>/sessions/<文件名>.json，照 2.1.304 写的字段 */
async function register(
  file: number,
  fields: { pid: number; sessionId: string; status?: string; procStart?: string },
): Promise<void> {
  await mkdir(registry, { recursive: true })
  await writeFile(
    join(registry, `${file}.json`),
    JSON.stringify({
      pid: fields.pid,
      sessionId: fields.sessionId,
      cwd: CWD,
      startedAt: Date.now(),
      procStart: fields.procStart ?? lstart(fields.pid),
      version: '2.1.304',
      kind: 'interactive',
      entrypoint: 'claude-desktop',
      status: fields.status ?? 'idle',
      updatedAt: Date.now(),
    }),
  )
}

let clock = Date.parse('2026-10-21T08:00:00.000Z')
const stamp = () => new Date((clock += 1000)).toISOString()

/** 原生记录里的一行（用户或助手的话），照 Claude Code 2.1 写的样子；extra 盖在最外层 */
function entry(
  session: string,
  type: 'user' | 'assistant',
  uuid: string,
  parentUuid: string | null,
  content: unknown,
  extra: Record<string, unknown> = {},
  message: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({
    parentUuid,
    isSidechain: false,
    userType: 'external',
    cwd: CWD,
    sessionId: session,
    version: '2.1.304',
    gitBranch: 'main',
    entrypoint: 'claude-desktop',
    type,
    message:
      type === 'user'
        ? { role: 'user', content, ...message }
        : {
            id: `msg_${uuid}`,
            type: 'message',
            role: 'assistant',
            model: 'claude-test',
            content,
            stop_reason: 'end_turn',
            ...message,
          },
    uuid,
    timestamp: stamp(),
    ...extra,
  })}\n`
}

const say = (session: string, uuid: string, parent: string | null, text: string) =>
  entry(session, 'user', uuid, parent, text)
const answer = (session: string, uuid: string, parent: string, text: string) =>
  entry(session, 'assistant', uuid, parent, [{ type: 'text', text }])

/** 原生记录的修改时间挪到一分钟以前：刚写过的在入口看来是别处还在写（兜底判定） */
async function settle(...files: string[]): Promise<void> {
  const past = new Date(Date.now() - 60_000)
  for (const file of files) await utimes(file, past, past)
}

async function write(session: string, content: string): Promise<void> {
  await mkdir(projectDir, { recursive: true })
  await writeFile(record(session), content)
  await settle(record(session))
}

async function append(session: string, content: string): Promise<void> {
  await appendFile(record(session), content)
  await settle(record(session))
}

async function fresh(): Promise<void> {
  await rm(join(config, 'projects'), { recursive: true, force: true })
  await rm(registry, { recursive: true, force: true })
}

async function withStage(name: string, run: (stage: Stage) => Promise<void>): Promise<void> {
  const stage = await openStage(name, { native: sdkNativeSessionSource() })
  try {
    await run(stage)
  } finally {
    await stage.dispose()
  }
}

const follow = (stage: Stage) =>
  (stage.server as unknown as { followNative(): Promise<void> }).followNative()

type Item = { type: string; id: string; status?: string; text?: string; phase?: string }
type Turn = { id: string; status: string; items: Item[]; durationMs: number | null }

async function turnsOf(
  app: { request: (m: string, p: unknown) => Promise<any> },
  threadId: string,
) {
  const read = await app.request('thread/read', { threadId, includeTurns: true })
  return read.thread.turns as Turn[]
}

test('RELAY-001：占用看交互进程的登记：进程活着、启动时间对得上、不是入口自己的才算；busy 是在跑', async () => {
  await fresh()
  const desktop = await liveProcess()
  const idle = await liveProcess()
  const own = new Set<number>([process.pid])
  const owners = new NativeOwners({ registryDir: () => registry, ownPids: () => own })
  assert.deepEqual([...owners.registered(true)], [], '没有登记目录时谁都不占')

  await register(desktop.pid as number, {
    pid: desktop.pid as number,
    sessionId: 's-busy',
    status: 'busy',
  })
  await register(idle.pid as number, { pid: idle.pid as number, sessionId: 's-idle' })
  // 进程号被复用了：登记的启动时间和这个进程号现在的对不上
  await register(91, {
    pid: idle.pid as number,
    sessionId: 's-reused',
    procStart: 'Thu Jan  1 00:00:00 1970',
  })
  // 入口自己起的 CLI（测试进程自己充当）
  await register(92, { pid: process.pid, sessionId: 's-own' })
  // 进程早没了
  await register(93, { pid: 4_000_000, sessionId: 's-dead', procStart: 'x' })
  await writeFile(join(registry, '94.json'), '{"pid":')
  assert.deepEqual(Object.fromEntries(owners.registered(true)), {
    's-busy': { entrypoint: 'claude-desktop', running: true },
    's-idle': { entrypoint: 'claude-desktop', running: false },
  })

  await stop(desktop)
  assert.deepEqual(
    [...owners.registered(true).keys()],
    ['s-idle'],
    '进程退出了（登记没删也一样）就不算',
  )
})

test('RELAY-002：别处开着时只读：会写原生记录的请求拒绝，声明了的连接看得到占用方；放手后通知并恢复可写', async () => {
  await fresh()
  const S = id(1)
  await write(S, say(S, 'u1', null, '桌面端说的') + answer(S, 'a1', 'u1', '好'))
  const desktop = await liveProcess()
  await register(desktop.pid as number, { pid: desktop.pid as number, sessionId: S })
  await withStage('relay-owner', async (stage) => {
    const litch = await stage.connect('litch', { litchExtensions: ['nativeOwner'] })
    const plain = await stage.connect('plain')
    const owner = { entrypoint: 'claude-desktop', running: false }

    const listed = await litch.request('thread/list', {})
    assert.deepEqual(listed.data[0].litchNativeOwner, owner)
    const bare = await plain.request('thread/list', {})
    assert.equal(bare.data[0].litchNativeOwner, undefined, '没声明的连接上没有这个字段')

    const resumed = await litch.request('thread/resume', { threadId: S })
    assert.deepEqual(resumed.thread.litchNativeOwner, owner)
    for (const [method, params] of [
      [
        'turn/start',
        { threadId: S, input: [{ type: 'text', text: '这边插一句', text_elements: [] }] },
      ],
      ['thread/compact/start', { threadId: S }],
      ['thread/rollback', { threadId: S, numTurns: 1 }],
      ['thread/inject_items', { threadId: S, items: [] }],
    ] as const) {
      // 没声明的连接一样拦得住
      const reply = await plain.raw(method, params)
      assert.equal(reply.error?.code, -32009, method)
      assert.match(reply.error.message, /此会话正由另一个进程接管，这边只读/)
      assert.match(reply.error.message, /归档这个会话或退出 Claude 桌面端/)
    }
    assert.equal((await turnsOf(litch, S)).length, 1, '一个回合都没多')

    // 对方开始跑：声明了的连接收到占用变了
    await register(desktop.pid as number, {
      pid: desktop.pid as number,
      sessionId: S,
      status: 'busy',
    })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await follow(stage)
    // 放手：进程退出
    await stop(desktop)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await follow(stage)
    assert.deepEqual(
      litch.notifications('litch/thread/nativeOwner/changed').map((message) => message.params),
      [
        { threadId: S, owner: { entrypoint: 'claude-desktop', running: true } },
        { threadId: S, owner: null },
      ],
    )
    assert.deepEqual(plain.notifications('litch/thread/nativeOwner/changed'), [])

    stage.script = async (_context, handlers) => {
      await handlers.onEvent({ type: 'completed', success: true, result: '好的' })
    }
    const { turn } = await litch.request('turn/start', {
      threadId: S,
      input: [{ type: 'text', text: '现在可以写了', text_elements: [] }],
    })
    assert.equal((await litch.completed(turn.id)).status, 'completed')
  })
})

/** 回合的样子：标识、状态、条目（类型:状态） */
const shapeOf = (turns: Turn[]) =>
  turns.map((turn) => ({
    id: turn.id,
    status: turn.status,
    items: turn.items.map((item) =>
      item.type === 'agentMessage'
        ? `${item.phase}:${item.text}`
        : item.status
          ? `${item.type}:${item.status}`
          : item.type,
    ),
  }))

test('RELAY-003：桌面端跑到一半时去画（脱敏的真实记录）：之后从最后一个导入回合的开头整段重画，不留 0 毫秒的回合和没头的半截', async () => {
  await fresh()
  const S = id(3)
  const scene = { sessionId: S, cwd: CWD }
  // 原来的问题：桌面端刚写下用户那句话、登记还没被认出来（这里不登记）时画了一遍
  await write(S, HALF_DRAWN.before(scene) + HALF_DRAWN.asked(scene))
  await withStage('relay-half', async (stage) => {
    const app = await stage.connect('app')
    await app.request('thread/list', {})
    let turns = await turnsOf(app, S)
    assert.deepEqual(
      turns.map((turn) => turn.id),
      ['p0', 'u1'],
    )
    // 助手调了命令，结果还没回来时又画了一遍：旧的画法这里多出一个以 a1 为标识、没有用户消息的回合
    await append(S, HALF_DRAWN.started(scene))
    turns = await turnsOf(app, S)
    assert.deepEqual(
      turns.map((turn) => turn.id),
      ['p0', 'u1'],
      '接着画的那段并回 u1，不另起没头的回合',
    )
    // 画的那一刻没人说对方还在跑：命令照旧记成失败，之后结果来了会改回来
    assert.deepEqual(shapeOf(turns)[1]?.items, [
      'userMessage',
      'reasoning',
      'commandExecution:failed',
    ])

    await append(S, HALF_DRAWN.finished(scene))
    turns = await turnsOf(app, S)
    assert.deepEqual(shapeOf(turns), [
      { id: 'p0', status: 'completed', items: ['userMessage', 'final_answer:都看过了'] },
      {
        id: 'u1',
        status: 'completed',
        items: [
          'userMessage',
          'reasoning',
          'commandExecution:completed',
          'final_answer:测试都过了，规则没动',
        ],
      },
    ])
    assert.ok((turns[1]?.durationMs ?? 0) > 0, '不再是 0 毫秒')
  })
})

test('RELAY-004：对方还在跑：最后一个回合是进行中，没结果的命令也是进行中；跑完后同一个回合补全', async () => {
  await fresh()
  const S = id(4)
  const scene = { sessionId: S, cwd: CWD }
  await write(S, HALF_DRAWN.before(scene) + HALF_DRAWN.asked(scene))
  const desktop = await liveProcess()
  await register(desktop.pid as number, {
    pid: desktop.pid as number,
    sessionId: S,
    status: 'busy',
  })
  await withStage('relay-running', async (stage) => {
    const app = await stage.connect('app')
    await app.request('thread/list', {})
    let turns = await turnsOf(app, S)
    assert.deepEqual(shapeOf(turns)[1], { id: 'u1', status: 'inProgress', items: ['userMessage'] })

    await append(S, HALF_DRAWN.started(scene))
    turns = await turnsOf(app, S)
    assert.deepEqual(shapeOf(turns)[1], {
      id: 'u1',
      status: 'inProgress',
      items: ['userMessage', 'reasoning', 'commandExecution:inProgress'],
    })

    // 回答写完了，登记还是 busy（停止钩子还没跑完）：照样是进行中
    await append(S, HALF_DRAWN.finished(scene))
    turns = await turnsOf(app, S)
    assert.deepEqual(shapeOf(turns)[1]?.status, 'inProgress')
    assert.deepEqual(shapeOf(turns)[1]?.items[2], 'commandExecution:completed')
    // 对方空闲下来（进程还在）：记录没再变，只是不在跑了，也要重画成完成
    await register(desktop.pid as number, {
      pid: desktop.pid as number,
      sessionId: S,
      status: 'idle',
    })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    turns = await turnsOf(app, S)
    assert.deepEqual(shapeOf(turns)[1]?.status, 'completed')
    assert.deepEqual(shapeOf(turns)[1]?.items.at(-1), 'final_answer:测试都过了，规则没动')
  })
  await stop(desktop)
})

test('RELAY-005：后台任务的结束通知之后那一轮单独成回合，来历是 backgroundTask；回合中途到的通知并进当前回合', async () => {
  await fresh()
  const S = id(5)
  const notice = (uuid: string, parent: string) =>
    entry(
      S,
      'user',
      uuid,
      parent,
      '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>',
      {
        origin: { kind: 'task-notification' },
        turnOrigin: 'task_notification',
      },
    )
  await write(
    S,
    say(S, 'u1', null, '后台跑个构建') +
      entry(
        S,
        'assistant',
        'a1',
        'u1',
        [
          {
            type: 'tool_use',
            id: 'k1',
            name: 'Bash',
            input: { command: 'make', run_in_background: true },
          },
        ],
        {},
        { stop_reason: 'tool_use' },
      ) +
      entry(S, 'user', 'r1', 'a1', [
        { type: 'tool_result', tool_use_id: 'k1', content: '已在后台运行' },
      ]) +
      // 回合还没停下就到的通知：并进 u1
      notice('n0', 'r1') +
      answer(S, 'a2', 'n0', '在跑了，等它结束') +
      // 回合停下之后到的通知：CLI 另起一轮
      notice('n1', 'a2') +
      answer(S, 'a3', 'n1', '构建跑完了'),
  )
  await withStage('relay-wake', async (stage) => {
    const app = await stage.connect('app', { litchExtensions: ['backgroundTasks'] })
    await app.request('thread/list', {})
    const read = await app.request('thread/read', { threadId: S, includeTurns: true })
    const turns = read.thread.turns as Array<Turn & { litchOrigin?: string }>
    assert.deepEqual(
      turns.map((turn) => [turn.id, turn.litchOrigin ?? null, turn.items.map((item) => item.type)]),
      [
        ['u1', null, ['userMessage', 'commandExecution', 'agentMessage']],
        ['n1', 'backgroundTask', ['agentMessage']],
      ],
    )
  })
})

const used = (input: number, output: number) => ({
  input_tokens: 10,
  cache_read_input_tokens: input,
  cache_creation_input_tokens: 0,
  output_tokens: output,
})

test('RELAY-006：导入会话的上下文用量取最后一次顶层请求，窗口按入口自己跑回合时记下的“模型 → 窗口”查，查不到是 null', async () => {
  await fresh()
  const S = id(6)
  await write(
    S,
    say(S, 'u1', null, '第一句') +
      // 同一次请求拆成两行写：各项取最大
      entry(
        S,
        'assistant',
        'a1',
        'u1',
        [{ type: 'thinking', thinking: '想', signature: 'x' }],
        {},
        { id: 'msg_1', usage: used(50_000, 10) },
      ) +
      entry(
        S,
        'assistant',
        'a2',
        'a1',
        [{ type: 'text', text: '好' }],
        {},
        { id: 'msg_1', usage: used(50_000, 300) },
      ) +
      // 子代理的请求不算
      entry(
        S,
        'assistant',
        'x1',
        'a2',
        [{ type: 'text', text: '子代理' }],
        { isSidechain: true },
        { id: 'msg_x', usage: used(900_000, 1) },
      ),
  )
  await withStage('relay-usage', async (stage) => {
    const app = await stage.connect('app')
    await app.request('thread/list', {})
    await app.request('thread/resume', { threadId: S })
    const replay = await app.notification('thread/tokenUsage/updated')
    assert.equal(replay.params.tokenUsage.last.totalTokens, 50_310)
    assert.equal(replay.params.tokenUsage.modelContextWindow, null, '没记过这个模型的窗口')

    // 入口自己跑一个回合，记下这个模型的窗口
    stage.script = async (_context, handlers) => {
      await handlers.onEvent({
        type: 'usage',
        usage: used(1, 1),
        contextWindow: 200_000,
        model: 'claude-test',
      })
      await handlers.onEvent({ type: 'completed', success: true, result: '好的' })
    }
    const { turn } = await app.request('turn/start', {
      threadId: S,
      input: [{ type: 'text', text: '这边跑一轮', text_elements: [] }],
    })
    await app.completed(turn.id)
    assert.equal(stage.store.modelWindow('claude-test'), 200_000)

    // 桌面端接着说了几句，又压缩过：占用换成压缩后的数，窗口查得到
    await append(
      S,
      say(S, 'u2', 'a2', '接着说') +
        entry(
          S,
          'assistant',
          'a3',
          'u2',
          [{ type: 'text', text: '收到' }],
          {},
          { id: 'msg_3', usage: used(80_000, 100) },
        ) +
        `${JSON.stringify({ parentUuid: null, logicalParentUuid: 'a3', isSidechain: false, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 80_110, postTokens: 12_000 }, uuid: 'cb', timestamp: stamp(), sessionId: S, entrypoint: 'claude-desktop' })}\n`,
    )
    const reread = await app.request('thread/read', { threadId: S, includeTurns: false })
    assert.ok(reread.thread)
    const updates = app.notifications('thread/tokenUsage/updated').map((message) => message.params)
    assert.deepEqual(updates.at(-1)?.tokenUsage.last.totalTokens, 12_000)
    assert.deepEqual(updates.at(-1)?.tokenUsage.modelContextWindow, 200_000)
  })
})

test('RELAY-007：桌面端压缩之后，只在压缩之后接着画，以前的回合（包括入口自己跑的）一个不删', async () => {
  await fresh()
  const S = id(7)
  await write(
    S,
    say(S, 'u1', null, '第一句') +
      answer(S, 'a1', 'u1', '一') +
      say(S, 'u2', 'a1', '第二句') +
      answer(S, 'a2', 'u2', '二'),
  )
  await withStage('relay-compact', async (stage) => {
    const app = await stage.connect('app')
    await app.request('thread/list', {})
    assert.deepEqual(
      (await turnsOf(app, S)).map((turn) => turn.id),
      ['u1', 'u2'],
    )
    // 压缩后的链从压缩边界开始（parentUuid 为 null），后面是摘要和新说的话
    await append(
      S,
      `${JSON.stringify({ parentUuid: null, logicalParentUuid: 'a2', isSidechain: false, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 100_000, postTokens: 9_000 }, uuid: 'cb', timestamp: stamp(), sessionId: S, entrypoint: 'claude-desktop', cwd: CWD })}\n` +
        entry(
          S,
          'user',
          's1',
          'cb',
          'This session is being continued from a previous conversation that ran out of context. Summary: ...',
          { isCompactSummary: true, isVisibleInTranscriptOnly: true },
        ) +
        say(S, 'u3', 's1', '压缩之后说的') +
        answer(S, 'a3', 'u3', '三'),
    )
    const turns = await turnsOf(app, S)
    assert.deepEqual(
      turns.map((turn) => [turn.id, turn.items.map((item) => item.type)]),
      [
        ['u1', ['userMessage', 'agentMessage']],
        ['u2', ['userMessage', 'agentMessage']],
        ['s1', ['contextCompaction']],
        ['u3', ['userMessage', 'agentMessage']],
      ],
      '摘要画成一条上下文压缩，不当成人说的话',
    )
  })
})

test('RELAY-008：停在会话上时自动刷新：新回合整个发 turn/started 或 turn/completed，变了的条目发 item/completed', async () => {
  await fresh()
  const S = id(8)
  const scene = { sessionId: S, cwd: CWD }
  await write(S, HALF_DRAWN.before(scene))
  const desktop = await liveProcess()
  await withStage('relay-follow', async (stage) => {
    const app = await stage.connect('app')
    await app.request('thread/list', {})
    await app.request('thread/resume', { threadId: S })
    await follow(stage)
    assert.deepEqual(app.notifications('turn/started'), [], '记录没变时什么都不发')

    // 桌面端开始跑一轮
    await register(desktop.pid as number, {
      pid: desktop.pid as number,
      sessionId: S,
      status: 'busy',
    })
    await append(S, HALF_DRAWN.asked(scene) + HALF_DRAWN.started(scene))
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await follow(stage)
    const started = app.notifications('turn/started').map((message) => message.params.turn)
    assert.deepEqual(
      started.map((turn) => [turn.id, turn.status, turn.items.map((item: Item) => item.type)]),
      [['u1', 'inProgress', ['userMessage', 'reasoning', 'commandExecution']]],
    )

    // 跑完了：留着的回合里变了的命令、多出来的回答发 item/completed，回合发 turn/completed（带全部条目）
    await append(S, HALF_DRAWN.finished(scene))
    await register(desktop.pid as number, {
      pid: desktop.pid as number,
      sessionId: S,
      status: 'idle',
    })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await follow(stage)
    const items = app
      .notifications('item/completed')
      .map((message) => [
        message.params.turnId,
        message.params.item.type,
        message.params.item.status ?? null,
      ])
    assert.deepEqual(items, [
      ['u1', 'commandExecution', 'completed'],
      ['u1', 'agentMessage', null],
    ])
    const completed = app.notifications('turn/completed').map((message) => message.params.turn)
    assert.deepEqual(
      completed.map((turn) => [turn.id, turn.status, turn.items.length]),
      [['u1', 'completed', 4]],
    )
  })
  await stop(desktop)
})

test('RELAY-009：设置跟着原生记录里别处最后用的走（模型、强度、bypass 是完全访问、计划模式）；入口自己写的行不算；用户在入口里改过的那一项不再跟', async () => {
  await fresh()
  const S = id(9)
  const desk = { requestedModel: 'claude-opus-5-5', effort: 'high' }
  await write(
    S,
    entry(S, 'user', 'u1', null, '第一句', { permissionMode: 'bypassPermissions' }) +
      entry(S, 'assistant', 'a1', 'u1', [{ type: 'text', text: '好' }], desk, {
        model: 'claude-opus-5-5',
      }),
  )
  await withStage('relay-settings', async (stage) => {
    const app = await stage.connect('app')
    await app.request('thread/list', {})
    const resumed = await app.request('thread/resume', { threadId: S })
    assert.equal(resumed.model, 'claude-opus-5-5')
    assert.equal(resumed.reasoningEffort, 'high')
    assert.equal(resumed.approvalPolicy, 'never')
    assert.equal(resumed.sandbox.type, 'dangerFullAccess')

    // 用户在入口里把强度改成 low
    await app.request('thread/settings/update', { threadId: S, effort: 'low' })
    // 入口自己跑的 CLI 写的行（程序化入口）：不算别处的设置
    await append(
      S,
      entry(S, 'user', 'u2', 'a1', '入口里说的', {
        entrypoint: 'sdk-ts',
        permissionMode: 'default',
      }) +
        entry(S, 'assistant', 'a2', 'u2', [{ type: 'text', text: '好' }], {
          entrypoint: 'sdk-ts',
          effort: 'low',
          requestedModel: 'claude-sonnet-5-5',
        }),
    )
    let read = await app.request('thread/resume', { threadId: S })
    assert.equal(read.model, 'claude-opus-5-5')
    assert.equal(read.approvalPolicy, 'never')

    // 桌面端那边换了强度、进了计划模式：强度用户改过，不跟；计划模式跟
    await append(
      S,
      entry(S, 'user', 'u3', 'a2', '桌面端又说', { permissionMode: 'plan' }) +
        entry(S, 'assistant', 'a3', 'u3', [{ type: 'text', text: '好' }], {
          ...desk,
          effort: 'xhigh',
          requestedModel: 'claude-sonnet-5-5',
        }),
    )
    read = await app.request('thread/resume', { threadId: S })
    assert.equal(read.reasoningEffort, 'low', '用户改过的强度不跟')
    assert.equal(read.model, 'claude-sonnet-5-5', '没改过的模型接着跟')
    assert.equal(stage.store.threadSettings(S).planMode, true)
    assert.equal(read.approvalPolicy, 'never', '计划模式不动权限')
  })
})

test('RELAY-010：原生记录里的事实：子代理、程序化入口、合成的助手消息不算；压缩后取压缩后的数，之后的请求再换回来', () => {
  const line = (value: object) => `${JSON.stringify(value)}\n`
  const facts = nativeRecordFacts(
    line({
      type: 'user',
      entrypoint: 'claude-desktop',
      permissionMode: 'acceptEdits',
      message: { role: 'user', content: 'x' },
    }) +
      line({
        type: 'assistant',
        entrypoint: 'claude-desktop',
        effort: 'medium',
        message: { id: 'm1', model: 'claude-a', usage: used(10, 1) },
      }) +
      line({
        type: 'assistant',
        entrypoint: 'sdk-ts',
        effort: 'low',
        requestedModel: 'claude-b',
        message: { id: 'm2', model: 'claude-b', usage: used(20, 1) },
      }) +
      line({
        type: 'assistant',
        entrypoint: 'claude-desktop',
        message: { id: 'm3', model: '<synthetic>', usage: used(0, 0) },
      }) +
      line({
        type: 'assistant',
        isSidechain: true,
        entrypoint: 'claude-desktop',
        effort: 'xhigh',
        message: { id: 'm4', model: 'claude-c', usage: used(99, 1) },
      }) +
      '{"type":"assistant", 坏掉的一行\n',
  )
  assert.deepEqual(facts.settings, {
    permissionMode: 'acceptEdits',
    model: 'claude-a',
    effort: 'medium',
  })
  assert.equal(facts.usage?.last.totalTokens, 31, '最后一次顶层请求是程序化入口那一次，用量照算')
  assert.equal(facts.usage?.model, 'claude-b')
  assert.equal(facts.compacted, false)

  const compacted = nativeRecordFacts(
    line({ type: 'assistant', message: { id: 'm1', model: 'claude-a', usage: used(500, 1) } }) +
      line({ type: 'system', subtype: 'compact_boundary', compactMetadata: { postTokens: 42 } }),
  )
  assert.deepEqual(
    [compacted.compacted, compacted.usage?.last.totalTokens, compacted.usage?.model],
    [true, 42, 'claude-a'],
  )
})

test('RELAY-011：旧的画法已经留在库里的 0 毫秒回合和没头的半截，下次重画时并回原来的回合', async () => {
  await fresh()
  const S = id(11)
  const scene = { sessionId: S, cwd: CWD }
  await write(S, HALF_DRAWN.before(scene) + HALF_DRAWN.asked(scene))
  await withStage('relay-repair', async (stage) => {
    const app = await stage.connect('app')
    await app.request('thread/list', {})
    assert.deepEqual(
      (await turnsOf(app, S)).map((turn) => turn.id),
      ['p0', 'u1'],
    )
    // 旧的画法第二次画时，从 u1 的边界往后接着画：助手的话成了以 a1 为标识的回合，命令记成失败
    await append(S, HALF_DRAWN.started(scene))
    const orphan = {
      id: 'a1',
      threadId: S,
      status: 'completed' as const,
      // 比 u1 晚：库里按开始时间排
      startedAt: Math.floor(Date.parse('2026-10-22T00:00:00Z') / 1000),
      completedAt: Math.floor(Date.parse('2026-10-22T00:00:00Z') / 1000),
      durationMs: 0,
      items: [{ type: 'reasoning' as const, id: 'a1:0', summary: ['先跑一遍测试'], content: [] }],
      diff: '',
      error: null,
    }
    stage.store.replaceNativeHistory(S, S, 2, [orphan], new Map([['a1', 'a2']]), 'old-mark')
    assert.deepEqual(
      (await stage.store.listTurns(S)).map((turn) => turn.id),
      ['p0', 'u1', 'a1'],
    )

    await append(S, HALF_DRAWN.finished(scene))
    const turns = await turnsOf(app, S)
    assert.deepEqual(
      shapeOf(turns).map((turn) => [turn.id, turn.items.length]),
      [
        ['p0', 2],
        ['u1', 4],
      ],
    )
  })
})

test('RELAY-012：盯着时登记重读、不用一秒内列表读过的；先画成结束、后来才知道对方在跑的回合发 turn/started 改回进行中', async () => {
  await fresh()
  const S = id(12)
  const scene = { sessionId: S, cwd: CWD }
  await write(S, HALF_DRAWN.before(scene))
  const desktop = await liveProcess()
  const idle = { pid: desktop.pid as number, sessionId: S, status: 'idle' }
  await register(desktop.pid as number, idle)
  await withStage('relay-late-busy', async (stage) => {
    const app = await stage.connect('app')
    await app.request('thread/list', {})
    await app.request('thread/resume', { threadId: S })
    await follow(stage)

    // 对方写下了一句话，登记还是空闲：画成结束
    await append(S, HALF_DRAWN.asked(scene))
    await follow(stage)
    assert.deepEqual(
      app
        .notifications('turn/completed')
        .map((message) => [message.params.turn.id, message.params.turn.status]),
      [['u1', 'completed']],
    )

    // 刚列过一次（空闲的登记进了缓存），紧接着登记变成 busy、记录没变：盯着的这一趟照样看得到
    await app.request('thread/list', {})
    await register(desktop.pid as number, { ...idle, status: 'busy' })
    await follow(stage)
    assert.deepEqual(
      app
        .notifications('turn/started')
        .map((message) => [message.params.turn.id, message.params.turn.status]),
      [['u1', 'inProgress']],
    )
  })
  await stop(desktop)
})
