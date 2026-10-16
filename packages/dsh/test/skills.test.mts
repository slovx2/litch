import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { compareWithBaseline } from '../../shared/test/compat-baseline.mjs'
import { StandardClient } from '../../shared/test/standard-client.mjs'
import { dshHome } from '../src/runtime.mjs'
import { DshServer } from '../src/server.mjs'
import { isSkillsSession } from '../src/skills.mjs'
import { promptContent } from '../src/turn.mjs'
import { client, isolate, violations } from './client.mjs'
import type { MockBlock } from './mock-model.mjs'

// dsh 入口的技能：清单问的是真的 dsh（隔离的状态目录、回环上的假模型），技能文件由用例摆进临时目录。
// 用例里“哪几处找、同名谁赢、哪些不列”都是 dsh 0.2.0-rc.2 实际的行为，dsh 换了做法这里要跟着改。

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// 一个像素的 PNG。
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// 摆一项技能：entry 以 .md 结尾的是平铺的一个文件，别的是 <entry>/SKILL.md。返回文件的位置。
async function skillFile(
  root: string,
  entry: string,
  fields: { name: string; description: string; extra?: string; body?: string },
): Promise<string> {
  const path = entry.endsWith('.md') ? join(root, entry) : join(root, entry, 'SKILL.md')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    `---\nname: ${fields.name}\ndescription: ${fields.description}\n${fields.extra ?? ''}---\n\n${fields.body ?? '正文'}\n`,
  )
  return path
}

type Scene = Awaited<ReturnType<typeof isolate>> & {
  home: string
  server: DshServer
  desktop: ReturnType<typeof client>
}

async function scene(
  respond: (body: any) => MockBlock[] = () => [{ type: 'text', chunks: ['好的。'] }],
): Promise<Scene> {
  const env = await isolate((body) =>
    body.tools?.length ? respond(body) : [{ type: 'text', chunks: ['mock 标题'] }],
  )
  const home = join(env.root, 'home')
  const server = new DshServer(home)
  const desktop = client(server)
  await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
  return { ...env, home, server, desktop }
}

async function dispose(s: Scene): Promise<void> {
  await s.server.close()
  await s.restore()
}

const listed = async (peer: ReturnType<typeof client>, cwd: string): Promise<any> =>
  (await peer.call('skills/list', { cwds: [cwd] })).data[0]

// 一直问到清单是想要的样子：文件刚落盘时 dsh 可能还没看见。
async function eventually(
  peer: ReturnType<typeof client>,
  cwd: string,
  wanted: (names: string[], entry: any) => boolean,
): Promise<any> {
  let entry: any
  for (let waited = 0; waited < 10000; waited += 50) {
    entry = await listed(peer, cwd)
    if (
      wanted(
        entry.skills.map((skill: any) => skill.name),
        entry,
      )
    )
      return entry
    await sleep(50)
  }
  assert.fail(`清单一直不是想要的样子：${JSON.stringify(entry)}`)
}

async function changed(peer: ReturnType<typeof client>, from: number): Promise<void> {
  for (let waited = 0; waited < 10000; waited += 25) {
    const found = peer.notifications.slice(from).find((entry) => entry.method === 'skills/changed')
    if (found) {
      assert.deepEqual(found.params, {})
      return
    }
    await sleep(25)
  }
  assert.fail('技能文件变了，没有收到 skills/changed')
}

// 发一个回合等它结束，返回这个回合里模型最后一次收到的请求（带工具的那种；不带工具的是 dsh 在起标题）。
async function turn(s: Scene, threadId: string, input: unknown[]): Promise<any> {
  const seen = s.model.requests.length
  const before = s.desktop.notifications.length
  await s.desktop.call('turn/start', { threadId, input })
  const done = await s.desktop.until(
    'turn/completed',
    (params) =>
      params.threadId === threadId &&
      s.desktop.notifications.findIndex((entry) => entry.params === params) >= before,
  )
  assert.equal(done.turn.status, 'completed', JSON.stringify(done.turn.error))
  return s.model.requests.slice(seen).findLast((body) => body.tools?.length)
}

// 模型这一次请求里用户这边的内容：文字块的字，和图片块的个数。
function said(body: any): { texts: string[]; images: number } {
  const blocks = (body?.messages ?? [])
    .filter((message: any) => message.role === 'user')
    .flatMap((message: any) =>
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : message.content,
    )
  return {
    texts: blocks.filter((block: any) => block.type === 'text').map((block: any) => block.text),
    images: blocks.filter((block: any) => block.type === 'image').length,
  }
}

test('SKILL-DSH-001：技能清单问的是 dsh：找哪几处、同名谁赢、来源范围、哪些不列', {
  timeout: 120000,
}, async () => {
  const s = await scene()
  try {
    const { desktop } = s
    // 项目根是带 .git 的那一层，工作目录在它下面的子目录里
    const cwd = join(s.cwd, 'pkg')
    await mkdir(join(s.cwd, '.git'))
    await mkdir(cwd)
    const project = join(s.cwd, '.dsh/skills')
    const projectAgents = join(s.cwd, '.agents/skills')
    const user = join(s.home, 'dsh-home/skills')
    const userAgents = join(s.root, 'agents-home/skills')
    const review = await skillFile(project, 'review', { name: 'review', description: '项目里的' })
    await skillFile(projectAgents, 'review', { name: 'review', description: '被项目 .dsh 的盖住' })
    const notes = await skillFile(projectAgents, 'notes', { name: 'notes', description: '记要点' })
    await skillFile(userAgents, 'notes', { name: 'notes', description: '被项目的盖住' })
    const flat = await skillFile(project, 'flat.md', {
      name: 'flat',
      description: '平铺的一个文件',
    })
    // 目录名和技能的名字不一样：认的是元数据里的名字
    const named = await skillFile(project, 'some-dir', { name: 'renamed', description: '名字另起' })
    const mine = await skillFile(user, 'mine', { name: 'mine', description: '用户自己的' })
    const shared = await skillFile(userAgents, 'shared', { name: 'shared', description: '共用的' })
    // 技能目录是个符号链接：dsh 给的是解开之后的位置，来源还是按链接所在的那一处算
    const linked = await skillFile(join(s.root, 'store'), 'linked', {
      name: 'linked',
      description: '链接过来的',
    })
    await symlink(join(s.root, 'store/linked'), join(userAgents, 'linked'))
    const manual = await skillFile(project, 'manual', {
      name: 'manual',
      description: '只给人点名用',
      extra: 'disable-model-invocation: true\n',
    })
    // 下面这几项列不出来：作者标了不给用户用的、元数据不合格的、嵌套的、子目录自己的
    await skillFile(project, 'hidden', {
      name: 'hidden',
      description: '不给用户用',
      extra: 'user-invocable: false\n',
    })
    await mkdir(join(project, 'broken'))
    await writeFile(join(project, 'broken/SKILL.md'), '---\nname: broken\n---\n\n没有说明\n')
    await skillFile(project, 'bad-name', { name: 'Bad_Name', description: '名字不合规矩' })
    await skillFile(project, 'group/nested', { name: 'nested', description: '嵌了一层' })
    await skillFile(join(cwd, '.dsh/skills'), 'inner', { name: 'inner', description: '子目录的' })

    const entry = await listed(desktop, cwd)
    assert.equal(entry.cwd, cwd)
    assert.deepEqual(entry.errors, [])
    assert.deepEqual(
      entry.skills.map((skill: any) => [skill.name, skill.path, skill.scope, skill.description]),
      [
        ['flat', flat, 'repo', '平铺的一个文件'],
        ['linked', linked, 'user', '链接过来的'],
        ['manual', manual, 'repo', '只给人点名用'],
        ['mine', mine, 'user', '用户自己的'],
        ['notes', notes, 'repo', '记要点'],
        ['renamed', named, 'repo', '名字另起'],
        ['review', review, 'repo', '项目里的'],
        ['shared', shared, 'user', '共用的'],
      ],
    )
    for (const skill of entry.skills)
      assert.deepEqual([skill.enabled, skill.pluginId], [true, null], skill.name)
    // forceReload 带不带一样：这一层不留缓存
    assert.deepEqual(
      (await desktop.call('skills/list', { cwds: [cwd], forceReload: true })).data[0],
      entry,
    )

    // 几个目录各一组；不在了的目录原因在它自己的 errors 里，也不会被建出来
    const missing = join(s.root, 'missing')
    const several = (await desktop.call('skills/list', { cwds: [missing, cwd] })).data
    assert.deepEqual(several[0], {
      cwd: missing,
      skills: [],
      errors: [{ path: missing, message: '工作目录不存在或不是目录' }],
    })
    assert.deepEqual(several[1], entry)
    assert.equal(existsSync(missing), false)
    // 不给目录：按适配器进程的当前目录
    for (const params of [{}, { cwds: [] }])
      assert.equal((await desktop.call('skills/list', params)).data[0].cwd, process.cwd())

    for (const params of [
      { cwds: 'x' },
      { cwds: ['relative/dir'] },
      { cwds: [1] },
      { forceReload: 'yes' },
    ])
      await assert.rejects(
        desktop.call('skills/list', params),
        (error: any) => error.code === -32602,
        JSON.stringify(params),
      )

    // 问技能用的会话不是线程
    assert.deepEqual((await desktop.call('thread/list', {})).data, [])
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await dispose(s)
  }
})

test('SKILL-DSH-002：带着技能发消息，技能的正文到了模型手里；带图片、回合中插话也一样', {
  timeout: 180000,
}, async () => {
  const MARK = 'REVIEW-BODY-7311'
  // 开头那句带 SLOW-MARK 的回合慢慢说（三秒，机器慢的时候插话也赶得上）；插的话到了之后照常答
  const s = await scene((body) =>
    JSON.stringify(body.messages).includes('SLOW-MARK') &&
    !JSON.stringify(body.messages).includes('插一句')
      ? [{ type: 'text', chunks: Array.from({ length: 30 }, () => '慢 '), delayMs: 100 }]
      : [{ type: 'text', chunks: ['好的。'] }],
  )
  try {
    const { desktop } = s
    await skillFile(join(s.cwd, '.dsh/skills'), 'review', {
      name: 'review',
      description: '审一下改动',
      body: `暗号是 ${MARK}`,
    })
    const [found] = (await listed(desktop, s.cwd)).skills
    assert.equal(found.name, 'review')
    // 桌面端选中一项技能之后发的就是这样一项，排在话前面（packages/core 的 toInput）
    const skill = { type: 'skill', name: found.name, path: found.path }
    const text = (value: string) => ({ type: 'text', text: value, text_elements: [] })
    const image = { type: 'image', url: `data:image/png;base64,${PIXEL}` }
    const expanded = (value: string) =>
      value.includes('<skill_content name="review">') && value.includes(MARK)
    // 每种情形各用一个新会话：展开过的正文会留在这个会话的历史里
    const fresh = async () => (await desktop.call('thread/start', { cwd: s.cwd })).thread.id

    const plain = said(await turn(s, await fresh(), [skill, text('看一下这次改动')]))
    assert.ok(plain.texts.includes('/review\n看一下这次改动'), JSON.stringify(plain.texts))
    assert.ok(plain.texts.some(expanded), '技能的正文到了模型')
    // 没选中技能、直接打字发来的“/名字”，官方桌面端发来时结尾带一个换行（Pi 入口因此认不出 /plan）：
    // dsh 认的是前后都是空白的词，换行也算，入口原样交就行
    const typed = said(await turn(s, await fresh(), [text('/review\n')]))
    assert.ok(typed.texts.includes('/review\n'), JSON.stringify(typed.texts))
    assert.ok(typed.texts.some(expanded), '打字发来的 /review 也展开了技能')

    // 不点名的时候模型只看得到名字和说明，正文不会自己过去
    const unasked = said(await turn(s, await fresh(), [text('看一下这次改动')]))
    assert.ok(unasked.texts.some((value) => value.includes('`review`: 审一下改动')))
    assert.ok(!unasked.texts.some((value) => value.includes(MARK)))

    // 带图片：技能照样展开，图片也到
    const pictured = said(await turn(s, await fresh(), [skill, text('看图'), image]))
    assert.ok(pictured.texts.includes('/review\n看图'), JSON.stringify(pictured.texts))
    assert.ok(pictured.texts.some(expanded), '带图片时技能的正文到了模型')
    assert.equal(pictured.images, 1)
    // 只有技能和图片，一个字都没写
    const bare = said(await turn(s, await fresh(), [skill, image]))
    assert.ok(bare.texts.includes('/review'), JSON.stringify(bare.texts))
    assert.ok(bare.texts.some(expanded), '只有技能和图片时技能的正文到了模型')
    assert.equal(bare.images, 1)

    // 回合进行中插话带技能（声明的 steerInputTypes 里有 skill）
    const threadId = await fresh()
    const seen = s.model.requests.length
    const started = await desktop.call('turn/start', { threadId, input: [text('SLOW-MARK')] })
    await desktop.until(
      'item/agentMessage/delta',
      (params) => params.threadId === threadId && params.delta.includes('慢'),
    )
    await desktop.call('turn/steer', {
      threadId,
      expectedTurnId: started.turn.id,
      input: [skill, text('插一句')],
    })
    const done = await desktop.until('turn/completed', (params) => params.threadId === threadId)
    assert.equal(done.turn.status, 'completed', JSON.stringify(done.turn.error))
    const steered = said(s.model.requests.slice(seen).findLast((body) => body.tools?.length))
    assert.ok(steered.texts.includes('/review\n插一句'), JSON.stringify(steered.texts))
    assert.ok(steered.texts.some(expanded), '插话带的技能的正文到了模型')
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await dispose(s)
  }
})

test('SKILL-DSH-003：dsh 的技能清单变了，问过清单的连接收到 skills/changed，再问是新的', {
  timeout: 180000,
}, async () => {
  // 技能文件由模型用 dsh 的写文件工具来改：dsh 自己写的文件它当场就知道。外面改的文件它要等系统的文件事件，
  // 文件事件积压的机器上（别处正在成批建删文件时）实测几十秒都看不见；那一段是 dsh 的事，这里不拿它当前提。
  const steps: MockBlock[][] = []
  const s = await scene(() => steps.shift() ?? [{ type: 'text', chunks: ['好的。'] }])
  try {
    const { desktop } = s
    const other = client(s.server)
    await other.call('initialize', { clientInfo: { name: 'other', version: '0' } })
    // 再接一条只说标准协议的连接：它收到的清单和通知按上游结构严格校验（多一个字段也算）
    const strict: StandardClient = new StandardClient((message) =>
      s.server.handle(peer, message as any),
    )
    const peer: RpcPeer = { id: 'strict', close() {}, send: (message) => strict.accept(message) }
    await strict.handshake({ name: 'strict', version: '0' }, null)
    await skillFile(join(s.cwd, '.dsh/skills'), 'first', { name: 'first', description: '头一个' })
    assert.deepEqual(
      (await listed(desktop, s.cwd)).skills.map((skill: any) => skill.name),
      ['first'],
    )
    assert.equal((await strict.ok('skills/list', { cwds: [s.cwd] })).data[0].skills.length, 1)

    const threadId = (await desktop.call('thread/start', { cwd: s.cwd, permissions: ':workspace' }))
      .thread.id
    // 让模型把一个文件写成这样（先读一遍：dsh 不让改没读过的文件），等回合结束，再等这之后的 skills/changed
    const rewrite = async (file: string, content: string) => {
      const mark = desktop.notifications.length
      steps.push(
        [{ type: 'tool_use', name: 'read', input: { file_path: file } }],
        [{ type: 'tool_use', name: 'write', input: { file_path: file, content } }],
      )
      await turn(s, threadId, [{ type: 'text', text: `写 ${file}` }])
      assert.equal(await readFile(join(s.cwd, file), 'utf8'), content, `dsh 写成了 ${file}`)
      await changed(desktop, mark)
    }

    await rewrite(
      '.dsh/skills/second/SKILL.md',
      '---\nname: second\ndescription: 后加的\n---\n\n正文\n',
    )
    await eventually(desktop, s.cwd, (names) => names.join() === 'first,second')

    await rewrite(
      '.dsh/skills/first/SKILL.md',
      '---\nname: first\ndescription: 改过的说明\n---\n\n正文\n',
    )
    await eventually(desktop, s.cwd, (_, entry) => entry.skills[0].description === '改过的说明')

    // 元数据没了的文件不再是一项技能：清单少一项
    await rewrite('.dsh/skills/second/SKILL.md', '没有元数据\n')
    await eventually(desktop, s.cwd, (names) => names.join() === 'first')

    // 只通知问过清单的连接
    assert.deepEqual((await strict.until('skills/changed')).params, {})
    assert.deepEqual(
      other.notifications.filter((entry) => entry.method === 'skills/changed'),
      [],
    )
    assert.deepEqual(compareWithBaseline('dsh', strict.findings.values()).unexpected, [])
    assert.deepEqual(strict.mistakes, [])
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await dispose(s)
  }
})

test('SKILL-DSH-004：问技能用的 dsh 会话一个目录只有一个，适配器重启之后也不进线程列表', {
  timeout: 120000,
}, async () => {
  const s = await scene()
  let server = s.server
  // dsh 那边只用来问技能的会话
  const probes = async () =>
    ((await (await server.remote()).rpc('session/list', { _request: {} })).items as any[]).filter(
      (item) => isSkillsSession(item.sessionId),
    )
  try {
    await skillFile(join(s.cwd, '.dsh/skills'), 'review', { name: 'review', description: '审' })
    // 头一次问就是两条连接同时来的：会话只建一个
    const other = client(server)
    await other.call('initialize', { clientInfo: { name: 'other', version: '0' } })
    await Promise.all([listed(s.desktop, s.cwd), listed(other, s.cwd)])
    await listed(s.desktop, s.cwd)
    assert.equal((await probes()).length, 1)

    // dsh 的会话是懒落盘的：刚建出来只在它的进程里，请求结束后的检查点才写下去（实测几十毫秒），
    // 在那之前 dsh 被结束的话，重启后就没有这个会话。等它落了盘再重启，才量得到下面这件事。
    const landed = async () =>
      (await readdir(join(dshHome(s.home), 'sessions'), { recursive: true }).catch(() => [])).some(
        (entry) => isSkillsSession(basename(dirname(entry))) && basename(entry) !== 'session.lock',
      )
    for (let waited = 0; !(await landed()); waited += 50) {
      assert.ok(waited < 10000, '问技能用的会话一直没有落盘')
      await sleep(50)
    }

    // 会话落了盘、dsh 的投影缓存还没来得及记它就收场的话，重启后 dsh 把它报成不空白（0.2.0-rc.2，
    // 见 thread-list.test.mts）；这种会话不是线程，入口按会话号认出它来，不靠那个标记
    await server.close()
    server = new DshServer(s.home)
    const desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    assert.deepEqual(
      (await probes()).map((item) => item.cwd),
      [s.cwd],
    )
    assert.deepEqual((await desktop.call('thread/list', {})).data, [])
    assert.deepEqual(
      (await listed(desktop, s.cwd)).skills.map((skill: any) => skill.name),
      ['review'],
    )
    assert.equal((await probes()).length, 1)
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await server.close()
    await s.restore()
  }
})

test('SKILL-DSH-005：技能输入化成单独一行的“/名字”，和话并成一段文字，图片跟在后面', async () => {
  const skill = { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' }
  const image = { type: 'image', url: `data:image/png;base64,${PIXEL}` }
  assert.deepEqual(await promptContent([skill, { type: 'text', text: '看一下\n第二行' }]), [
    { type: 'text', text: '/review\n看一下\n第二行' },
  ])
  assert.deepEqual(await promptContent([skill]), [{ type: 'text', text: '/review' }])
  assert.deepEqual(await promptContent([skill, { type: 'text', text: '看图' }, image]), [
    { type: 'text', text: '/review\n看图' },
    { type: 'image', mediaType: 'image/png', data: PIXEL },
  ])
})
