import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { HarnessFeatures, PermissionPreset } from '../../protocol/src/harness-capabilities.mjs'
import { declaration } from '../src/declaration.mjs'
import { client, type Isolated, isolate, skip, text, violations } from './client.mjs'
import { type MockBlock, type MockResponder, scripted } from './mock-model.mjs'

// 这个文件守着 `runtime/info` 里的结构化声明（src/declaration.mts）和实际行为一致：
// 声明支持的调了确实成，声明不支持的调了确实被拒。改了声明或对应的实现，这里要跟着过。
const features = declaration.features as HarnessFeatures
const presets = declaration.permissionPresets as PermissionPreset[]

// 一个像素的 PNG
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

type Scene = Isolated & { desktop: ReturnType<typeof client> }

async function scene(
  respond: MockResponder,
  options: Parameters<typeof isolate>[1] = {},
  extensions: string[] = [],
): Promise<Scene> {
  const env = await isolate(respond, options)
  const desktop = client(env.server, extensions)
  await desktop.initialize()
  return { ...env, desktop }
}

// 按声明调用：声明支持的必须成功；声明不支持的必须答“方法不存在”，不能假装成功。
async function declared(s: Scene, supported: boolean, method: string, params: unknown) {
  if (supported) return s.desktop.call(method, params)
  await assert.rejects(
    s.desktop.call(method, params),
    (error: any) => error.code === -32601,
    `${method} 声明为不支持，应当答 -32601`,
  )
  return null
}

async function run(s: Scene, threadId: string, input: unknown[], extra: object = {}): Promise<any> {
  const { turn } = await s.desktop.call('turn/start', { threadId, input, ...extra })
  return (await s.desktop.until('turn/completed', (p) => p.turn.id === turn.id, 60000)).turn
}

// 模型收到的最后一次（带工具的）请求
const lastAsk = (s: Scene) => s.model.requests.filter((body) => body.tools?.length).at(-1)

test('OpenCode：runtime/info 带结构化声明', { skip, timeout: 60000 }, async () => {
  const s = await scene(scripted({}))
  try {
    const info = await s.desktop.call('runtime/info')
    assert.equal(info.engine, 'opencode')
    assert.equal(info.releaseReady, false)
    assert.deepEqual(info.capabilities, ['submission.idempotency'])
    const { displayName, badge, extensions, features: wired, permissionPresets } = info
    assert.deepEqual(
      { displayName, badge, extensions, features: wired, permissionPresets },
      declaration,
    )
    assert.deepEqual([displayName, badge], ['OpenCode', 'OC'])
    assert.deepEqual(extensions, ['declineWithNote', 'clientTools', 'harnessConfig'])
    assert.deepEqual(
      presets.map((preset) => [
        preset.id,
        preset.risk,
        preset.requiresConfirmation,
        preset.switchDuringTurn,
      ]),
      [
        [':read-only', 'low', false, false],
        [':workspace', 'medium', false, false],
        [':danger-full-access', 'high', true, false],
      ],
    )
  } finally {
    await s.restore()
  }
  assert.deepEqual([...violations], [])
})

test('OpenCode：输入种类（图片、设备上的图片、文件引用、技能）都交到模型', {
  skip,
  timeout: 120000,
}, async () => {
  const s = await scene(scripted({}), {
    files: {
      'notes.md': '笔记里的暗号 ZEBRA-42\n',
      'pixel.png': '',
      '.opencode/command/greet.md':
        '---\ndescription: 打个招呼\n---\n向 $ARGUMENTS 问好，暗号 COMMAND-77\n',
    },
  })
  try {
    await writeFile(join(s.cwd, 'pixel.png'), Buffer.from(PIXEL, 'base64'))
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    assert.deepEqual(features.inputTypes, ['text', 'image', 'localImage', 'skill', 'mention'])

    const images = await run(s, thread.id, [
      { type: 'text', text: '看图', text_elements: [] },
      { type: 'image', url: `data:image/png;base64,${PIXEL}` },
      { type: 'localImage', path: join(s.cwd, 'pixel.png') },
    ])
    assert.equal(images.status, 'completed', JSON.stringify(images.error))
    const sent = JSON.stringify(lastAsk(s).messages)
    assert.equal(sent.split(`data:image/png;base64,${PIXEL}`).length - 1, 2, '两张图都交给了模型')

    const mention = await run(s, thread.id, [
      { type: 'text', text: '读一下', text_elements: [] },
      { type: 'mention', name: 'notes.md', path: join(s.cwd, 'notes.md') },
    ])
    assert.equal(mention.status, 'completed')
    assert.ok(JSON.stringify(lastAsk(s).messages).includes('ZEBRA-42'), '引用的文件内容交给了模型')

    const skills = await s.desktop.call('skills/list', { cwds: [s.cwd] })
    const greet = skills.data[0].skills.find((entry: any) => entry.name === 'greet')
    assert.ok(greet, 'OpenCode 的自定义命令列成技能')
    assert.equal(greet.path, join(s.cwd, '.opencode/command/greet.md'))
    assert.equal(greet.scope, 'repo')
    const skill = await run(s, thread.id, [
      { type: 'skill', name: 'greet', path: greet.path },
      { type: 'text', text: '小明', text_elements: [] },
    ])
    assert.equal(skill.status, 'completed', JSON.stringify(skill.error))
    const asked = JSON.stringify(lastAsk(s).messages)
    assert.ok(asked.includes('COMMAND-77') && asked.includes('小明'), '命令模板展开后交给了模型')
    // 回显照客户端发来的样子
    assert.equal(skill.items[0].content[0].type, 'skill')
  } finally {
    await s.restore()
  }
  assert.deepEqual([...violations], [])
})

const slow = (marker: string): Record<string, MockBlock[][]> => ({
  [marker]: [
    [{ type: 'text', chunks: Array.from({ length: 60 }, (_, i) => `慢${i} `), delayMs: 80 }],
  ],
})

test('OpenCode：插话并进同一回合，打断让回合以 interrupted 收场', {
  skip,
  timeout: 120000,
}, async () => {
  const s = await scene(
    scripted({
      ...slow('SLOW'),
      STEERED: [[{ type: 'text', chunks: ['收到插话。'] }]],
    }),
  )
  try {
    const { desktop } = s
    const { thread } = await desktop.call('thread/start', { cwd: s.cwd })
    assert.equal(features.steer, true)
    const { turn } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: text('SLOW 说慢点'),
    })
    await desktop.until('item/agentMessage/delta', (p) => p.turnId === turn.id)
    const steered = await desktop.call('turn/steer', {
      threadId: thread.id,
      expectedTurnId: turn.id,
      input: text('STEERED 插一句'),
    })
    assert.equal(steered.turnId, turn.id)
    const done = (await desktop.until('turn/completed', (p) => p.turn.id === turn.id, 60000)).turn
    assert.equal(done.status, 'completed')
    const users = done.items.filter((item: any) => item.type === 'userMessage')
    assert.deepEqual(
      users.map((item: any) => item.content[0].text),
      ['SLOW 说慢点', 'STEERED 插一句'],
      '插话在同一回合里',
    )
    assert.equal(done.items.at(-1).text, '收到插话。')

    assert.equal(features.interrupt, true)
    const next = await desktop.call('turn/start', { threadId: thread.id, input: text('SLOW 再来') })
    await desktop.until('item/agentMessage/delta', (p) => p.turnId === next.turn.id)
    await desktop.call('turn/interrupt', { threadId: thread.id, turnId: next.turn.id })
    const stopped = (await desktop.until('turn/completed', (p) => p.turn.id === next.turn.id)).turn
    assert.equal(stopped.status, 'interrupted')
    // 回放和直播一致
    const read = await desktop.call('thread/read', { threadId: thread.id, includeTurns: true })
    assert.deepEqual(
      read.thread.turns.map((t: any) => [t.id, t.status]),
      [
        [turn.id, 'completed'],
        [next.turn.id, 'interrupted'],
      ],
    )
  } finally {
    await s.restore()
  }
  assert.deepEqual([...violations], [])
})

const edit = (from: string, to: string): MockBlock => ({
  type: 'tool',
  name: 'edit',
  input: { filePath: 'a.txt', oldString: from, newString: to },
})

test('OpenCode：分叉、回退（连文件一起恢复）、按个数回退、压缩、改名、归档、删除；设备侧队列不支持', {
  skip,
  timeout: 180000,
}, async () => {
  const s = await scene(
    scripted({
      ONE: [[edit('v0', 'v1')], [{ type: 'text', chunks: ['一'] }]],
      TWO: [[edit('v1', 'v2')], [{ type: 'text', chunks: ['二'] }]],
      THREE: [[edit('v2', 'v3')], [{ type: 'text', chunks: ['三'] }]],
    }),
    { files: { 'a.txt': 'v0\n' } },
  )
  try {
    const { desktop } = s
    const file = join(s.cwd, 'a.txt')
    const { thread } = await desktop.call('thread/start', { cwd: s.cwd })
    const threadId = thread.id
    const one = await run(s, threadId, text('ONE'))
    const two = await run(s, threadId, text('TWO'))
    const three = await run(s, threadId, text('THREE'))
    assert.equal(await readFile(file, 'utf8'), 'v3\n')

    // 分叉：保留到第二轮（含）。新会话里的回合号是新的，内容照旧
    const forked = await declared(s, features.fork, 'thread/fork', { threadId, lastTurnId: two.id })
    assert.notEqual(forked.thread.id, threadId)
    assert.equal(forked.thread.forkedFromId, threadId)
    assert.deepEqual(
      forked.thread.turns.map((turn: any) => turn.items[0].content[0].text),
      ['ONE', 'TWO'],
    )
    await desktop.until('thread/started', (p) => p.thread.id === forked.thread.id)
    const before = await declared(s, features.fork, 'thread/fork', {
      threadId,
      beforeTurnId: two.id,
    })
    assert.deepEqual(
      before.thread.turns.map((turn: any) => turn.items[0].content[0].text),
      ['ONE'],
    )

    // 回退到第三轮之前：历史截掉，文件也恢复成第二轮之后的样子
    assert.equal(features.revert.restoresFiles, true)
    const reverted = await declared(s, features.revert.byTurnId, 'thread/revert', {
      threadId,
      beforeTurnId: three.id,
    })
    assert.deepEqual(reverted.thread.turns ?? [], [], '应答里不带回合')
    const read = await desktop.call('thread/read', { threadId, includeTurns: true })
    assert.deepEqual(
      read.thread.turns.map((turn: any) => turn.id),
      [one.id, two.id],
    )
    assert.equal(await readFile(file, 'utf8'), 'v2\n')
    // 按个数：再退一轮
    await declared(s, features.revert.byCount, 'thread/rollback', { threadId, numTurns: 1 })
    const after = await desktop.call('thread/read', { threadId, includeTurns: true })
    assert.deepEqual(
      after.thread.turns.map((turn: any) => turn.id),
      [one.id],
    )
    assert.equal(await readFile(file, 'utf8'), 'v1\n')

    // 压缩跑成一个回合，里面是上下文压缩条目
    await declared(s, features.compact, 'thread/compact/start', { threadId })
    const compacted = await desktop.until('turn/completed', (p) =>
      p.turn.items.some((item: any) => item.type === 'contextCompaction'),
    )
    assert.equal(compacted.turn.status, 'completed')

    await declared(s, features.rename, 'thread/name/set', { threadId, name: '声明测试' })
    assert.equal((await desktop.call('thread/read', { threadId })).thread.name, '声明测试')
    await declared(s, features.archive, 'thread/archive', { threadId })
    assert.equal(
      (await desktop.call('thread/list', { archived: true })).data.some(
        (t: any) => t.id === threadId,
      ),
      true,
    )
    await declared(s, features.archive, 'thread/unarchive', { threadId })
    assert.equal(
      (await desktop.call('thread/list', {})).data.some((t: any) => t.id === threadId),
      true,
    )
    await declared(s, features.queue, 'thread/queue/add', {
      threadId,
      clientUserMessageId: 'queued',
      input: text('排队的一句'),
    })
    await declared(s, features.delete, 'thread/delete', { threadId })
    await assert.rejects(
      desktop.call('thread/read', { threadId }),
      (error: any) => error.code === -32602,
    )
  } finally {
    await s.restore()
  }
  assert.deepEqual([...violations], [])
})

test('OpenCode：回合正在跑时截在它（或更早的回合）之前分叉，只带走已结束的回合，源回合照常跑完', {
  skip,
  timeout: 180000,
}, async () => {
  const s = await scene(
    scripted({
      ONE: [[{ type: 'text', chunks: ['一'] }]],
      TWO: [[{ type: 'text', chunks: ['二'] }]],
      // 进行中的一轮先改一次文件，再慢慢说话：分叉时 OpenCode 里已经存着这一轮的用户消息和工具调用
      RUNNING: [[edit('v0', 'v1')], slow('RUNNING').RUNNING![0]!],
      FOLLOW: [[{ type: 'text', chunks: ['接着'] }]],
    }),
    { files: { 'a.txt': 'v0\n' } },
  )
  try {
    const { desktop } = s
    const { thread } = await desktop.call('thread/start', { cwd: s.cwd })
    const threadId = thread.id
    const one = await run(s, threadId, text('ONE'))
    const two = await run(s, threadId, text('TWO'))
    const { turn } = await desktop.call('turn/start', { threadId, input: text('RUNNING 第三轮') })
    await desktop.until('item/agentMessage/delta', (p) => p.turnId === turn.id, 60000)
    const busy = (params: object) =>
      assert.rejects(
        desktop.call('thread/fork', { threadId, ...params }),
        (error: any) => error.code === -32009,
      )
    // 不截在某一回合之前的分叉、回退照旧拒绝
    await busy({})
    await busy({ lastTurnId: two.id })
    await assert.rejects(
      desktop.call('thread/rollback', { threadId, numTurns: 1 }),
      (error: any) => error.code === -32009,
    )
    const firstTexts = (turns: any[]) => turns.map((t: any) => t.items[0].content[0].text)
    const atRunning = await desktop.call('thread/fork', { threadId, beforeTurnId: turn.id })
    assert.deepEqual(firstTexts(atRunning.thread.turns), ['ONE', 'TWO'])
    assert.ok(atRunning.thread.turns.every((t: any) => t.status === 'completed'))
    const atTwo = await desktop.call('thread/fork', { threadId, beforeTurnId: two.id })
    assert.deepEqual(firstTexts(atTwo.thread.turns), ['ONE'])
    // 源回合照常跑完，源会话三轮都在
    const done = (await desktop.until('turn/completed', (p) => p.turn.id === turn.id, 60000)).turn
    assert.equal(done.status, 'completed')
    const source = await desktop.call('thread/read', { threadId, includeTurns: true })
    assert.deepEqual(
      source.thread.turns.map((t: any) => t.id),
      [one.id, two.id, turn.id],
    )
    // 分叉接着聊：重读还是两轮，模型收到的历史里没有进行中那一轮的任何东西
    const reread = await desktop.call('thread/read', {
      threadId: atRunning.thread.id,
      includeTurns: true,
    })
    assert.deepEqual(firstTexts(reread.thread.turns), ['ONE', 'TWO'])
    await run(s, atRunning.thread.id, text('FOLLOW'))
    const messages = lastAsk(s).messages
    const asked = JSON.stringify(messages)
    assert.ok(asked.includes('ONE') && asked.includes('TWO'))
    assert.ok(!asked.includes('RUNNING'), asked)
    assert.ok(!messages.some((m: any) => m.role === 'tool' || m.tool_calls?.length), asked)
  } finally {
    await s.restore()
  }
  assert.deepEqual([...violations], [])
})

test('OpenCode：只读档拿不到改文件和命令工具，完全访问档来问的一律放行，计划模式出计划条目', {
  skip,
  timeout: 180000,
}, async () => {
  const s = await scene(
    scripted({
      FULL: [
        [{ type: 'tool', name: 'bash', input: { command: 'printf ran', description: '跑' } }],
        [{ type: 'text', chunks: ['跑完了'] }],
      ],
      PLAN: [[{ type: 'text', chunks: ['1. 先看\n', '2. 再改'] }]],
    }),
    { permission: { bash: 'ask', edit: 'ask' } },
  )
  try {
    const { desktop } = s
    const tools = () => (lastAsk(s).tools as any[]).map((tool) => tool.function.name)
    const { thread } = await desktop.call('thread/start', { cwd: s.cwd, permissions: ':read-only' })
    const readOnly = await run(s, thread.id, text('随便聊聊'))
    assert.equal(readOnly.status, 'completed')
    for (const name of ['edit', 'write', 'bash', 'task'])
      assert.equal(tools().includes(name), false, name)
    assert.ok(tools().includes('read'))

    // 换到完全访问档：下一轮生效，OpenCode 来问的直接放行，不转给客户端
    const full = await run(s, thread.id, text('FULL 跑一下'), {
      permissions: ':danger-full-access',
    })
    assert.equal(full.status, 'completed', JSON.stringify(full.error))
    assert.ok(tools().includes('bash'))
    const command = full.items.find((item: any) => item.type === 'commandExecution')
    assert.equal(command.aggregatedOutput, 'ran')
    assert.equal(desktop.requests.length, 0, '完全访问档不来问')
    assert.equal(
      (await desktop.call('thread/read', { threadId: thread.id })).thread.activePermissionProfile,
      ':danger-full-access',
    )

    // 计划模式：OpenCode 的 plan 代理，回答画成计划条目
    const plan = await run(s, thread.id, text('PLAN 出个计划'), {
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'mock/m1', reasoning_effort: null, developer_instructions: null },
      },
    })
    assert.equal(plan.status, 'completed')
    assert.deepEqual(
      plan.items.map((item: any) => item.type),
      ['userMessage', 'plan'],
    )
    assert.equal(plan.items[1].text, '1. 先看\n2. 再改')
  } finally {
    await s.restore()
  }
  assert.deepEqual([...violations], [])
})
