import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { DshServer } from '../src/server.mjs'
import { client, isolate, violations } from './client.mjs'
import type { MockBlock } from './mock-model.mjs'

// 回给客户端的用户消息是它发来的样子：实时的回显、重读历史都是。dsh 的会话记录里图片只有附件号
//（它收图时另存一份，可能缩小、转码过），技能只是一句“/名字”，所以适配器把发来的输入原样记了一份；
// 这一份没了的时候（适配器的库丢了、记这一份之前发的消息）照 dsh 的记录来。对着 dsh 0.2.0-rc.2。

// 一个像素的 PNG。
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const text = (value: string) => ({ type: 'text', text: value, text_elements: [] })
const image = { type: 'image', url: `data:image/png;base64,${PIXEL}` }

type Scene = Awaited<ReturnType<typeof isolate>> & {
  home: string
  server: DshServer
  desktop: ReturnType<typeof client>
}

// title：dsh 请模型起标题时（不带工具的那种请求）假模型回的字。回空的就是标题没生成成。
async function scene(
  respond: (body: any) => MockBlock[] = () => [{ type: 'text', chunks: ['好的。'] }],
  title = 'mock 标题',
): Promise<Scene> {
  const env = await isolate((body) =>
    body.tools?.length ? respond(body) : [{ type: 'text', chunks: [title] }],
  )
  const home = join(env.root, 'home')
  const server = new DshServer(home)
  const desktop = client(server)
  await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
  return { ...env, home, server, desktop }
}

// 适配器重启：同一个状态目录上另起一个服务和一条连接。
async function restart(s: Scene): Promise<void> {
  await s.server.close()
  s.server = new DshServer(s.home)
  s.desktop = client(s.server)
  await s.desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
}

// 发一个回合等它结束，返回实时回显的那条用户消息的内容。
async function echoed(s: Scene, threadId: string, input: unknown[]): Promise<any[]> {
  const { turn } = await s.desktop.call('turn/start', { threadId, input })
  const done = await s.desktop.until(
    'turn/completed',
    (params) => params.threadId === threadId && params.turn.id === turn.id,
  )
  assert.equal(done.turn.status, 'completed', JSON.stringify(done.turn.error))
  const found = s.desktop.notifications.find(
    (entry) =>
      entry.method === 'item/completed' &&
      entry.params.threadId === threadId &&
      entry.params.turnId === turn.id &&
      entry.params.item.type === 'userMessage',
  )
  return found.params.item.content
}

// 重读历史：会话里各条用户消息的内容，按先后。
async function history(s: Scene, threadId: string): Promise<any[][]> {
  const { thread } = await s.desktop.call('thread/read', { threadId, includeTurns: true })
  return thread.turns.flatMap((turn: any) =>
    turn.items.filter((item: any) => item.type === 'userMessage').map((item: any) => item.content),
  )
}

// 模型最近一次收到的请求里图片块的个数。
const pictures = (s: Scene): number =>
  (s.model.requests.findLast((body) => body.tools?.length)?.messages ?? [])
    .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
    .filter((block: any) => block.type === 'image').length

test('ECHO-DSH-001：带图的用户消息，回显和重读历史里都有图，是发来的样子；记录没了照 dsh 存下的那份给', {
  timeout: 180000,
}, async () => {
  // 带 SLOW 的回合慢慢说，插话赶得上；插的话到了之后照常答
  const s = await scene((body) =>
    JSON.stringify(body.messages).includes('SLOW') &&
    !JSON.stringify(body.messages).includes('补一张')
      ? [{ type: 'text', chunks: Array.from({ length: 30 }, () => '慢 '), delayMs: 100 }]
      : [{ type: 'text', chunks: ['好的。'] }],
  )
  try {
    const file = join(s.root, 'shot.png')
    await writeFile(file, Buffer.from(PIXEL, 'base64'))
    const local = { type: 'localImage', path: file }
    const threadId = (await s.desktop.call('thread/start', { cwd: s.cwd })).thread.id

    // 一句话带两张图：一张带地址的，一张本地文件。回显的就是发来的这几项
    const first = [text('看这两张图'), image, local]
    assert.deepEqual(await echoed(s, threadId, first), first)
    assert.equal(pictures(s), 2, '两张图都到了模型')
    // 只有图、一个字都没写
    const second = [image]
    assert.deepEqual(await echoed(s, threadId, second), second)

    // 回合中插话带图：插的那句也是发来的样子
    const { turn } = await s.desktop.call('turn/start', { threadId, input: [text('SLOW')] })
    await s.desktop.until(
      'item/agentMessage/delta',
      (params) => params.threadId === threadId && params.turnId === turn.id,
    )
    const steered = [text('补一张'), image]
    await s.desktop.call('turn/steer', { threadId, expectedTurnId: turn.id, input: steered })
    const done = await s.desktop.until('turn/completed', (params) => params.turn.id === turn.id)
    assert.equal(done.turn.status, 'completed', JSON.stringify(done.turn.error))
    const said = [first, second, [text('SLOW')], steered]
    assert.deepEqual(
      done.turn.items.filter((item: any) => item.type === 'userMessage').map((i: any) => i.content),
      said.slice(2),
    )

    // 重读历史一样；适配器重启后从 dsh 重新读也一样
    assert.deepEqual(await history(s, threadId), said)
    await restart(s)
    assert.deepEqual(await history(s, threadId), said)

    // dsh 自己分叉出来的会话带着原来的记录和提交标识：那几条用户消息照样对得上
    const remote = await s.server.remote()
    const forked = await remote.rpc('session/fork', { request: { sessionId: threadId } })
    assert.deepEqual(await history(s, forked.sessionId), said)

    // 适配器的库丢了：字还在，图是 dsh 存下的那一份，一律成了带地址的图片（本地文件的路径没有了）
    await s.server.close()
    for (const suffix of ['', '-wal', '-shm'])
      await rm(join(s.home, `adapter.sqlite${suffix}`), { force: true })
    s.server = new DshServer(s.home)
    s.desktop = client(s.server)
    await s.desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const bare = await history(s, threadId)
    assert.deepEqual(
      bare.map((content) => content.map((item) => item.type)),
      [['text', 'image', 'image'], ['text', 'image'], ['text'], ['text', 'image']],
    )
    assert.deepEqual(
      bare.map((content) => content[0].text),
      ['看这两张图', '', 'SLOW', '补一张'],
    )
    for (const item of bare.flat().filter((entry) => entry.type === 'image'))
      assert.equal(item.url, image.url, '这张图小，dsh 存下的就是原件')
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await s.server.close()
    await s.restore()
  }
})

// 会话在线程列表里的名字和预览。
async function listed(s: Scene, threadId: string): Promise<{ name: unknown; preview: unknown }> {
  const { data } = await s.desktop.call('thread/list', { limit: 50 })
  const { name, preview } = data.find((thread: any) => thread.id === threadId)
  return { name, preview }
}

// 这条连接上收到的会话名字，按先后。
const named = (s: Scene, threadId: string): unknown[] =>
  s.desktop.notifications
    .filter((entry) => entry.method === 'thread/name/updated' && entry.params.threadId === threadId)
    .map((entry) => entry.params.threadName)

test('ECHO-DSH-002：带技能的用户消息，回显和重读历史里是一项技能加那句话；预览和名字里没有“/名字”', {
  timeout: 180000,
}, async () => {
  const MARK = 'NOTES-BODY-5207'
  // 标题没生成成的会话：dsh 的标题一直是它的兜底标题（头一句话开头的几个词）
  const s = await scene(undefined, '')
  try {
    const path = join(s.cwd, '.dsh/skills/fixture-notes/SKILL.md')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `---\nname: fixture-notes\ndescription: 记要点\n---\n\n暗号是 ${MARK}\n`)
    const [found] = (await s.desktop.call('skills/list', { cwds: [s.cwd] })).data[0].skills
    assert.equal(found.name, 'fixture-notes')
    const skill = { type: 'skill', name: found.name, path: found.path }
    const fresh = async () => (await s.desktop.call('thread/start', { cwd: s.cwd })).thread.id
    // 模型最近一次收到的请求里用户这边的字
    const told = (): string[] =>
      (s.model.requests.findLast((body) => body.tools?.length)?.messages ?? [])
        .filter((message: any) => message.role === 'user')
        .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)

    // 会话头一句就带技能：回显是发来的那两项；交给 dsh 的照旧是“/名字”，技能的正文到了模型
    const threadId = await fresh()
    const first = [skill, text('带着技能说一句')]
    assert.deepEqual(await echoed(s, threadId, first), first)
    assert.ok(told().includes('/fixture-notes\n带着技能说一句'), JSON.stringify(told()))
    assert.ok(
      told().some((value) => value.includes(MARK)),
      '技能的正文到了模型',
    )
    // 用户自己随手写的“/名字”还是一句话，不会变成技能
    const typed = [text('/fixture-notes 是我自己打的字')]
    assert.deepEqual(await echoed(s, threadId, typed), typed)
    // 预览是那句话；dsh 的兜底标题（“/fixture-notes 带着技能说一句”）不当名字，也不通知
    assert.deepEqual(await listed(s, threadId), { name: null, preview: '带着技能说一句' })
    assert.deepEqual(named(s, threadId), [])
    const dsh = async (id: string) =>
      (await (await s.server.remote()).rpc('session/projections', { request: { sessionId: id } }))
        .values.title
    assert.equal(await dsh(threadId), '/fixture-notes 带着技能说一句', '前提：dsh 那边是兜底标题')

    // 只点了技能、一个字没写：回显就是那一项，预览才用“/名字”
    const bare = await fresh()
    assert.deepEqual(await echoed(s, bare, [skill]), [skill])
    assert.deepEqual(await listed(s, bare), { name: null, preview: '/fixture-notes' })

    // 用户改的名字照旧是名字
    await s.desktop.call('thread/name/set', { threadId: bare, name: '我起的名字' })
    await s.desktop.until('thread/name/updated', (params) => params.threadName === '我起的名字')
    assert.equal((await listed(s, bare)).name, '我起的名字')

    // 适配器重启后（会话没打开，清单是 dsh 给的）预览和名字一样；重读历史也一样
    await restart(s)
    assert.deepEqual(await listed(s, threadId), { name: null, preview: '带着技能说一句' })
    assert.deepEqual(await listed(s, bare), { name: '我起的名字', preview: '/fixture-notes' })
    // 适配器没跟着的时候在 dsh 那边改的名（比如在 dsh 自己的界面里），照 dsh 的
    const remote = await s.server.remote()
    await remote.rpc('session/rename', { request: { sessionId: bare, title: '在 dsh 里改的' } })
    assert.equal((await listed(s, bare)).name, '在 dsh 里改的')
    assert.deepEqual(await history(s, threadId), [first, typed])
    assert.deepEqual(await listed(s, threadId), { name: null, preview: '带着技能说一句' })

    // 适配器的库丢了：技能认不回来，是交给 dsh 的那一句（不照字猜：那会把用户自己写的“/名字”也当成技能）
    await s.server.close()
    for (const suffix of ['', '-wal', '-shm'])
      await rm(join(s.home, `adapter.sqlite${suffix}`), { force: true })
    s.server = new DshServer(s.home)
    s.desktop = client(s.server)
    await s.desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    assert.deepEqual(await history(s, threadId), [[text('/fixture-notes\n带着技能说一句')], typed])
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await s.server.close()
    await s.restore()
  }
})

test('ECHO-DSH-003：dsh 的模型起了标题，会话的名字就是它；头一句带技能时名字里从头到尾没有“/名字”，会话长了也一样', {
  timeout: 180000,
}, async () => {
  const s = await scene()
  try {
    const path = join(s.cwd, '.dsh/skills/fixture-notes/SKILL.md')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '---\nname: fixture-notes\ndescription: 记要点\n---\n\n正文\n')
    const [found] = (await s.desktop.call('skills/list', { cwds: [s.cwd] })).data[0].skills
    const threadId = (await s.desktop.call('thread/start', { cwd: s.cwd })).thread.id
    const input = [{ type: 'skill', name: found.name, path: found.path }, text('带着技能说一句')]
    assert.deepEqual(await echoed(s, threadId, input), input)
    await s.desktop.until('thread/name/updated', (params) => params.threadId === threadId)
    // 只有模型起的那一个，兜底标题没有当名字发过
    assert.deepEqual(named(s, threadId), ['mock 标题'])
    assert.deepEqual(await listed(s, threadId), { name: 'mock 标题', preview: '带着技能说一句' })
    await restart(s)
    const shown = { name: 'mock 标题', preview: '带着技能说一句' }
    assert.deepEqual(await listed(s, threadId), shown)

    // 会话长了，dsh 的快照只带末尾一段记录（它默认给最近 50 条消息），头一句和标题都不在里面：
    // 打开之后预览和名字照旧，也不会拿这一段把记下的改掉
    for (let i = 0; i < 26; i++) await echoed(s, threadId, [text(`第 ${i} 句`)])
    await restart(s)
    const { thread } = await s.desktop.call('thread/resume', { threadId })
    assert.ok(
      !thread.turns.some((turn: any) =>
        turn.items.some(
          (item: any) => item.type === 'userMessage' && item.content[0].type === 'skill',
        ),
      ),
      '前提：快照里没有头一句',
    )
    assert.deepEqual({ name: thread.name, preview: thread.preview }, shown)
    assert.deepEqual(await listed(s, threadId), shown)
    await restart(s)
    assert.deepEqual(await listed(s, threadId), shown)
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await s.server.close()
    await s.restore()
  }
})
