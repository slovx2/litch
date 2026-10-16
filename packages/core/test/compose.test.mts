// 写消息时的几样：技能清单怎么问、怎么投影，带着技能的消息怎么发出去。
// 对着假对端和假的聚合面跑，会话经真的通道订阅（wire.mts 的 watchSession）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type ChannelError,
  createMockCore,
  type SkillOption,
  type SkillProblem,
  type UserMessageItem,
} from '../src/index.mjs'
import { deviceWorld, features } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { RpcFailure } from './fake-server.mjs'
import { thread, turn } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { setup, watch, where } from './world.mjs'

const never = { aborted: false, addEventListener() {} }

async function failureOf(run: Promise<unknown>): Promise<ChannelError> {
  try {
    await run
  } catch (error) {
    return error as ChannelError
  }
  throw new Error('这条命令本该失败')
}

const skill = (name: string, fields: Record<string, unknown> = {}) => ({
  name,
  description: `${name} 的说明`,
  path: `/skills/${name}/SKILL.md`,
  scope: 'user',
  enabled: true,
  pluginId: null,
  ...fields,
})

test('技能清单：按工作目录问；停用的、没名字的、重复的不列，说明只留第一行；没列出来的带着原因', async () => {
  const world = setup(undefined, {
    'skills/list': () => ({
      data: [
        {
          cwd: '/work/app',
          skills: [
            skill('review', {
              description: '第一行\n第二行',
              interface: { displayName: 'Review', iconSmallUrl: null, iconLargeUrl: null },
            }),
            skill('off', { enabled: false }),
            skill('', {}),
            skill('review'),
            skill('odd', { scope: 'elsewhere', shortDescription: '短说明' }),
          ],
          errors: [
            { path: '/skills/bad/SKILL.md', message: '元数据不合格\n第二行不要' },
            { path: '/skills/bad/SKILL.md', message: '元数据不合格' },
            { path: '/skills/mute/SKILL.md', message: '  ' },
          ],
        },
        // 别的目录那一份里的也算；对面给的不是清单时当没有
        { cwd: '/work/lib', skills: [], errors: [{ path: '/work/lib', message: '目录不在了' }] },
        { cwd: '/work/odd', skills: [], errors: null },
      ],
    }),
  })
  world.core.start()
  await settle()
  const { skills, problems } = (await world.command('device.skills', {
    deviceId: 'local',
    cwd: '/work/app',
  })) as { skills: SkillOption[]; problems: SkillProblem[] }
  // 原话只留第一段，同一句只留一份，没说原因的不算
  assert.deepEqual(problems, [
    { path: '/skills/bad/SKILL.md', message: '元数据不合格' },
    { path: '/work/lib', message: '目录不在了' },
  ])
  assert.deepEqual(skills, [
    {
      name: 'review',
      title: 'Review',
      note: '第一行',
      path: '/skills/review/SKILL.md',
      scope: 'user',
    },
    // 不认识的来源不照搬；另外给的短说明排在长说明前面
    { name: 'odd', title: 'odd', note: '短说明', path: '/skills/odd/SKILL.md', scope: null },
  ])
  // 单个入口上不带 harness；工作目录原样给
  assert.deepEqual(world.sent('skills/list'), [{ cwds: ['/work/app'] }])

  // 没有工作目录：不带 cwds，由对面按它自己的当前目录看
  await world.command('device.skills', { deviceId: 'local', cwd: null })
  assert.deepEqual(world.sent('skills/list')[1], {})
})

test('技能清单：对面不认识这个方法是“不支持”，别的错照原话报', async () => {
  // 假对端默认没有 skills/list：回的是标准的“方法不存在”
  const lacking = setup()
  lacking.core.start()
  await settle()
  const first = await failureOf(lacking.command('device.skills', { deviceId: 'local', cwd: null }))
  assert.equal(first.code, 'unsupported')

  // 原生 codex 自己的入口：不认识的方法回“无效请求”，原因里点了名
  const native = setup(undefined, {
    'skills/list': () => {
      throw new RpcFailure(-32600, 'Invalid request: unknown variant `skills/list`')
    },
  })
  native.core.start()
  await settle()
  const second = await failureOf(native.command('device.skills', { deviceId: 'local', cwd: null }))
  assert.equal(second.code, 'unsupported')

  const broken = setup(undefined, {
    'skills/list': () => {
      throw new RpcFailure(-32603, '技能目录读不出来')
    },
  })
  broken.core.start()
  await settle()
  const third = await failureOf(broken.command('device.skills', { deviceId: 'local', cwd: null }))
  assert.equal(third.code, 'remote')
  assert.equal(third.message, '技能目录读不出来')

  // 没连上：不去问
  const idle = setup()
  const fourth = await failureOf(idle.command('device.skills', { deviceId: 'local', cwd: null }))
  assert.equal(fourth.code, 'offline')
})

test('技能清单：聚合面上指明问哪个 harness；声明了带不了技能的不去问', async () => {
  const listed: unknown[] = []
  /** 现在不可用的那个 harness */
  let gone = ''
  const world = deviceWorld(
    [
      harness('cc', {
        declaration: { features: features({ inputTypes: ['text', 'image', 'skill'] }) },
      }),
      // 声明里的输入种类没有技能
      harness('plain', { declaration: { features: features() } }),
      // 旧版的适配器：没有声明，问了才知道
      harness('old'),
    ],
    {
      extra: {
        'skills/list': (params) => {
          listed.push(params)
          const { harness: target } = params as { harness?: string }
          if (target === 'old') throw new RpcFailure(-32601, 'Method not found: skills/list')
          // 聚合面转不过去的时候是它自己回错，原因写在 data 里
          if (target === gone) {
            throw new RpcFailure(-32050, `${target} 现在不可用`, {
              litch: 'harnessUnavailable',
              harness: target,
            })
          }
          return { data: [{ cwd: '/work/app', skills: [skill(`${target}-one`)], errors: [] }] }
        },
      },
    },
  )
  world.core.start()
  await settle()
  const abilities = Object.fromEntries(
    (world.device()?.harnesses ?? []).map((entry) => [entry.id, entry.abilities?.skills ?? null]),
  )
  assert.deepEqual(abilities, { cc: true, plain: false, old: null })

  const { skills } = (await world.command('device.skills', {
    harness: 'cc',
    cwd: '/work/app',
  })) as { skills: SkillOption[] }
  assert.deepEqual(
    skills.map((entry) => entry.name),
    ['cc-one'],
  )
  assert.deepEqual(listed, [{ cwds: ['/work/app'], harness: 'cc' }])

  const declared = await failureOf(world.command('device.skills', { harness: 'plain', cwd: null }))
  assert.equal(declared.code, 'unsupported')
  assert.equal(listed.length, 1, '声明了带不了的不该去问')

  const tried = await failureOf(world.command('device.skills', { harness: 'old', cwd: null }))
  assert.equal(tried.code, 'unsupported')
  assert.equal(listed.length, 2)

  // 它现在不可用：说得出是哪个 harness
  gone = 'cc'
  const down = await failureOf(world.command('device.skills', { harness: 'cc', cwd: null }))
  assert.equal(down.code, 'remote')
  assert.equal(down.text?.key, 'fault.harnessUnavailable')
})

test('带技能的消息：技能排在输入的最前面，只有技能没有字也能发；先显示出来的那条带着技能的名字', async () => {
  const world = setup([thread({ id: 'a', turns: [] })])
  world.core.start()
  await settle()
  const session = watch(world.core)
  await settle()
  const review = { kind: 'skill', name: 'review', path: '/skills/review/SKILL.md' }
  await world.command('session.send', { ...where, text: '看一下这次改动', extras: [review] })
  assert.deepEqual((world.sent('turn/start')[0] as { input: unknown }).input, [
    { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
    { type: 'text', text: '看一下这次改动', text_elements: [] },
  ])
  const view = session.seen.view
  const first = view?.items[view.turns[0]?.itemIds[0] ?? ''] as UserMessageItem
  assert.deepEqual(first.attachments, [{ kind: 'skill', label: 'review' }])
  assert.equal(first.text, '看一下这次改动')

  // 回合还在进行：下一条排着队，带的技能跟着它
  await world.command('session.send', { ...where, text: '', extras: [review] })
  assert.deepEqual(session.seen.view?.queued[0]?.extras, [review])

  // 形状不对的不发，也不悄悄丢掉
  for (const extras of [[{ kind: 'skill', name: '', path: '/x' }], [{ kind: 'other' }]]) {
    const refused = await failureOf(world.command('session.send', { ...where, text: '嗯', extras }))
    assert.equal(refused.code, 'rejected')
  }
  const empty = await failureOf(world.command('session.send', { ...where, text: ' ', extras: [] }))
  assert.equal(empty.code, 'rejected')
})

test('带着一段文字的消息：协议里没有文本附件，发出去时并回正文，跟在打的字后面', async () => {
  const world = setup([thread({ id: 'a', turns: [] })])
  world.core.start()
  await settle()
  const session = watch(world.core)
  await settle()
  const log = { kind: 'text', name: null, text: '第一行日志\n第二行日志' }
  const more = { kind: 'text', name: 'trace.txt', text: '另一段' }
  await world.command('session.send', { ...where, text: '看看哪里错了', extras: [log, more] })
  assert.deepEqual((world.sent('turn/start')[0] as { input: unknown }).input, [
    {
      type: 'text',
      text: '看看哪里错了\n\n第一行日志\n第二行日志\n\ntrace.txt:\n另一段',
      text_elements: [],
    },
  ])
  // 先显示出来的那一条和发出去的是同一段话，不另外画成附件
  const view = session.seen.view
  const first = view?.items[view.turns[0]?.itemIds[0] ?? ''] as UserMessageItem
  assert.equal(first.text, '看看哪里错了\n\n第一行日志\n第二行日志\n\ntrace.txt:\n另一段')
  assert.deepEqual(first.attachments, [])

  // 回合还在进行：下一条排着队，带的文字原样跟着它（拿回输入框改的时候还是单独的一段）。只带文字、没打字也能发
  await world.command('session.send', { ...where, text: '', extras: [log] })
  assert.deepEqual(session.seen.view?.queued[0]?.extras, [log])
  world.peer.last().notify('turn/completed', {
    threadId: 'a',
    turn: turn('srv-1', [], { status: 'completed' }),
  })
  await settle()
  assert.deepEqual((world.sent('turn/start')[1] as { input: unknown }).input, [
    { type: 'text', text: '第一行日志\n第二行日志', text_elements: [] },
  ])

  // 和技能一起带：技能还是排在最前面
  const review = { kind: 'skill', name: 'review', path: '/skills/review/SKILL.md' }
  world.peer.last().notify('turn/completed', {
    threadId: 'a',
    turn: turn('srv-2', [], { status: 'completed' }),
  })
  await settle()
  await world.command('session.send', { ...where, text: '嗯', extras: [log, review] })
  assert.deepEqual((world.sent('turn/start')[2] as { input: unknown }).input, [
    { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
    { type: 'text', text: '嗯\n\n第一行日志\n第二行日志', text_elements: [] },
  ])

  // 空的、太长的、名字不对的不收
  for (const bad of [
    { kind: 'text', name: null, text: '  \n ' },
    { kind: 'text', name: null, text: 'x'.repeat(1_000_001) },
    { kind: 'text', name: '', text: '有字' },
    { kind: 'text', name: null },
  ]) {
    const refused = await failureOf(
      world.command('session.send', { ...where, text: '嗯', extras: [bad] }),
    )
    assert.equal(refused.code, 'rejected')
  }
})

test('模拟核心：各 harness 的技能各是各的，没有声明的不认识，有一个目录头一回取不到', async () => {
  const time = fakeClock()
  const core = createMockCore({ clock: time.clock, chunkMs: 0 })
  const ask = (deviceId: string, harnessId: string | undefined, cwd: string | null) =>
    core.command(
      'device.skills',
      { deviceId, ...(harnessId ? { harness: harnessId } : {}), cwd },
      never,
    ) as Promise<{ skills: SkillOption[]; problems: SkillProblem[] }>
  const names = async (deviceId: string, harnessId: string, cwd: string | null) =>
    (await ask(deviceId, harnessId, cwd)).skills.map((entry) => entry.name)

  assert.equal((await names('local', 'claude', '/work/litch')).length, 6)
  // 没有工作目录：仓库里带的那几项看不到
  assert.deepEqual(await names('local', 'claude', null), [
    'flaky-test',
    'write-tests',
    'changelog',
    'pdf',
  ])
  assert.deepEqual(await names('local', 'pi', null), ['commit', 'summarize'])
  assert.deepEqual(await names('local', 'dsh', '/work/litch'), [])

  // 直接连的那台原生 codex 没有声明：问了才知道它不认识
  assert.equal((await failureOf(ask('nas', undefined, null))).code, 'unsupported')
  // 没连上的设备、用不了的 harness 都问不成
  assert.equal((await failureOf(ask('gpu', 'claude', null))).code, 'offline')
  assert.equal((await failureOf(ask('local', 'codex', null))).code, 'remote')

  // 同一台设备上别的目录不受影响
  assert.deepEqual(await names('build', 'pi', '/srv/work/infra'), ['commit', 'summarize'])
  const flaky = await failureOf(ask('build', 'pi', '/var/cache/ci'))
  assert.equal(flaky.code, 'remote')
  const again = await ask('build', 'pi', '/var/cache/ci')
  assert.deepEqual(
    again.skills.map((entry) => entry.name),
    ['commit', 'summarize'],
  )
  // 取到的这一份里有一项没列出来；别的地方没有
  assert.deepEqual(
    again.problems.map((entry) => entry.message),
    ['开头的元数据里没有 description'],
  )
  assert.deepEqual((await ask('build', 'pi', '/srv/work/infra')).problems, [])
})

test('模拟核心：应答晚一点到，界面上看得到“正在取”', async () => {
  const time = fakeClock()
  const core = createMockCore({ clock: time.clock, chunkMs: 60 })
  let settled = false
  const asking = core
    .command('device.skills', { deviceId: 'local', harness: 'pi', cwd: null }, never)
    .then(() => {
      settled = true
    })
  await settle()
  assert.equal(settled, false)
  time.advance(200)
  await asking
  assert.equal(settled, true)
})
