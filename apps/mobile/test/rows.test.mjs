// 会话视图 → 对话区的行（src/core/rows.ts）：过程连成一组、展开收起、末尾的状态行、内容没变的行复用同一个对象。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askQuestionId, askReplyText, projectItem } from '@litch/core'
import { formatSessionEvent } from '../../../packages/protocol/src/session-tree.mts'
import { recoverMessage, restartMessage } from '../../../packages/protocol/src/system-messages.mts'
import { RowBuilder } from '../src/core/rows.ts'
import { experiment } from '../src/experiment.ts'

experiment.seal = 300

const user = (id, text) => ({ id, kind: 'userMessage', text, attachments: [] })
const answer = (id, text, status = 'completed') => ({
  id,
  kind: 'agentMessage',
  text,
  phase: 'final',
  status,
})
const command = (id, status, exitCode = null) => ({
  id,
  kind: 'command',
  command: `run ${id}`,
  cwd: '/w',
  output: `${id} 的输出`,
  elided: null,
  exitCode,
  durationMs: status === 'inProgress' ? null : 12,
  startedAt: null,
  query: '',
})
const notice = (id) => ({ id, kind: 'notice', label: '进入审查模式', detail: null })

function viewOf(turns, items) {
  return {
    forkedFrom: null,
    can: { finalOnStart: false },
    agents: [],
    proposals: [],
    requests: [],
    turns: turns.map((turn) => ({
      startedAt: null,
      durationMs: null,
      error: null,
      ...turn,
    })),
    items: Object.fromEntries(items.map((item) => [item.id, item])),
  }
}

const types = (rows) => rows.map((row) => row.type)

for (const phase of ['unknown', 'commentary']) {
  test(`回合结束的文字与工具：${phase} 按原生阶段决定是否整段折叠`, () => {
    const builder = new RowBuilder()
    const items = [
      user('u', '检查'),
      { ...answer('n1', '开始检查'), phase },
      command('c1', 'completed', 0),
      { ...answer('n2', '中间的重要结论'), phase },
      command('c2', 'completed', 0),
      answer('final', '完成'),
    ]
    const view = viewOf([{ id: 't', status: 'completed', itemIds: items.map((i) => i.id) }], items)
    const rows = builder.build(view, 'all')
    const content = rows.filter((row) => row.type === 'md' || row.type === 'group')
    assert.deepEqual(
      content.map((row) => (row.type === 'md' ? row.itemId : 'tools')),
      phase === 'unknown' ? ['n1', 'tools', 'n2', 'tools', 'final'] : ['final'],
    )
    assert.ok(rows.filter((row) => row.type === 'group').every((row) => !row.expanded))
    builder.toggle('t:process', 't')
    assert.deepEqual(
      builder
        .build(view, 'all')
        .filter((row) => row.type === 'md')
        .map((r) => r.itemId),
      ['n1', 'n2', 'final'],
    )
  })
}

test('混合阶段回合只隐藏明确 commentary，unknown 正文前后工具摘要都保留', () => {
  const items = [
    user('u', '检查'),
    { ...answer('note', '明确的过程说明'), phase: 'commentary' },
    command('c1', 'completed', 0),
    { ...answer('finding', '重要结论'), phase: 'unknown' },
    command('c2', 'completed', 0),
    answer('final', '完成'),
  ]
  const view = viewOf([{ id: 't', status: 'completed', itemIds: items.map((i) => i.id) }], items)
  assert.deepEqual(
    new RowBuilder()
      .build(view, 'all')
      .filter((row) => row.type === 'md' || row.type === 'group')
      .map((row) => (row.type === 'md' ? row.itemId : 'tools')),
    ['tools', 'finding', 'tools', 'final'],
  )
})

for (const scenario of ['插话', '压缩', '插话和压缩']) {
  test(`进行中的最后一段保持展开：${scenario}后继续说明和调用工具`, () => {
    const builder = new RowBuilder()
    const items = [user('u', '开始'), command('c0', 'completed', 0), answer('a0', '阶段结论')]
    if (scenario.includes('插话')) items.push(user('peer', '来自经理的补充'))
    items.push({ ...answer('n1', '继续检查'), phase: 'commentary' })
    if (scenario.includes('压缩'))
      items.push({ id: 'compact', kind: 'compaction', status: 'completed', source: 'automatic' })
    items.push(
      { ...answer('n2', '压缩后继续输出'), phase: 'commentary' },
      command('c2', 'inProgress'),
    )
    const build = (status = 'running') => {
      const view = viewOf([{ id: 't', status, itemIds: items.map((item) => item.id) }], items)
      view.can.finalOnStart = true
      return builder.build(view, 'all')
    }
    for (let i = 0; i < 3; i++) {
      items.push({ ...answer(`live-${i}`, `新增说明 ${i}`), phase: 'commentary' })
      const rows = build()
      assert.ok(
        rows.some((row) => row.type === 'md' && row.itemId === `live-${i}`),
        '新说明必须可见',
      )
      assert.ok(
        rows.some((row) => row.type === 'group'),
        '当前工具组必须可见',
      )
      if (scenario.includes('压缩'))
        assert.ok(
          rows.findIndex((row) => row.type === 'compaction') <
            rows.findIndex((row) => row.itemId === 'n2'),
        )
    }
    items[items.findIndex((item) => item.id === 'c2')].status = 'completed'
    items.push(answer('final', '最终结果'))
    assert.ok(
      build().some((row) => row.itemId === 'n2'),
      'final 写完也等回合结束',
    )
    const done = build('completed')
    assert.ok(done.some((row) => row.type === 'process' && !row.expanded))
    assert.ok(!done.some((row) => row.itemId === 'n2'), '回合结束后恢复折叠')
  })
}

test('插话前一段的工具和回答都结束才折叠；条目状态更新无需新增条目', () => {
  const builder = new RowBuilder()
  const items = [
    user('u', '开始'),
    { ...command('c', 'inProgress'), status: 'inProgress' },
    answer('a', '阶段结论', 'inProgress'),
    user('peer', '补充'),
    { ...answer('n', '仍在处理'), phase: 'commentary' },
  ]
  const build = () =>
    builder.build(
      viewOf([{ id: 't', status: 'running', itemIds: items.map((item) => item.id) }], items),
      'all',
    )
  assert.ok(!build().some((row) => row.type === 'process'))
  items[2].status = 'completed'
  assert.ok(!build().some((row) => row.type === 'process'), '回答结束但工具未结束')
  items[1].status = 'completed'
  const rows = build()
  assert.equal(rows.filter((row) => row.type === 'process').length, 1)
  assert.ok(
    rows.some((row) => row.itemId === 'n'),
    '最后一段仍然展开',
  )
})

test('问答只在同回合紧邻时合并；插入会话消息的两种顺序和重读历史都保留答案位置', () => {
  const q = {
    ...answer('q', ''),
    questions: [{ id: askQuestionId('q', 0), title: '接下来做什么？', options: [] }],
  }
  const reply = user(
    'reply',
    askReplyText([
      { questionItemId: askQuestionId('q', 0), question: '接下来做什么？', answer: '先做其他事情' },
    ]),
  )
  const peer = {
    ...user('peer', '补齐证据'),
    peer: { name: '基建', session: 'other', bypass: false },
  }
  for (const items of [
    [q, reply],
    [q, peer, reply],
    [q, command('work', 'completed'), reply, peer],
  ]) {
    for (const status of ['running', 'completed']) {
      const view = viewOf([{ id: 't', status, itemIds: items.map((item) => item.id) }], items)
      for (const snapshot of [view, structuredClone(view)]) {
        const rows = new RowBuilder().build(snapshot, 'all')
        const users = rows.filter((row) => row.type === 'user')
        assert.equal(
          users.some((row) => row.key === 'reply'),
          items.length !== 2,
        )
        if (items.length > 2) {
          assert.equal(users.find((row) => row.key === 'reply').text, reply.text)
          assert.deepEqual(
            users.map((row) => row.key),
            items.filter((item) => item.kind === 'userMessage').map((item) => item.id),
          )
        }
      }
    }
  }
  const separate = viewOf(
    [
      { id: 'old', status: 'completed', itemIds: ['q'] },
      { id: 'new', status: 'running', itemIds: ['reply', 'peer'] },
    ],
    [q, reply, peer],
  )
  assert.ok(
    new RowBuilder()
      .build(separate, 'all')
      .some((row) => row.type === 'user' && row.key === 'reply'),
  )
})

test('问答与过程分段一起工作：较早两段分别折叠，答复保留原位，运行中的最后一段持续展开', () => {
  const q = {
    ...answer('q', ''),
    questions: [{ id: askQuestionId('q', 0), title: '下一步做什么？', options: [] }],
  }
  const reply = user(
    'reply',
    askReplyText([
      { questionItemId: askQuestionId('q', 0), question: '下一步做什么？', answer: '先做其他事情' },
    ]),
  )
  const peer = {
    ...user('peer', '补齐证据'),
    peer: { name: '基建', session: 'other', bypass: false },
  }
  for (const messages of [
    [reply, peer],
    [peer, reply],
  ]) {
    const items = [
      q,
      user('start', '继续处理'),
      command('c0', 'completed', 0),
      answer('a0', '第一段结论'),
      messages[0],
      command('c1', 'completed', 0),
      answer('a1', '第二段结论'),
      messages[1],
      { ...answer('n2', '最后一段继续处理'), phase: 'commentary' },
      command('c2', 'inProgress'),
    ]
    const source = viewOf(
      [
        { id: 'old', status: 'completed', itemIds: ['q'] },
        { id: 'live', status: 'running', itemIds: items.slice(1).map((item) => item.id) },
      ],
      items,
    )
    for (const view of [source, structuredClone(source)]) {
      const builder = new RowBuilder()
      const rows = builder.build(view, 'all')
      const users = rows.filter((row) => row.type === 'user')
      assert.deepEqual(
        users.map((row) => row.key),
        ['start', ...messages.map((item) => item.id)],
      )
      assert.equal(users.find((row) => row.key === 'reply').text, reply.text)
      const folded = rows.filter((row) => row.type === 'process')
      assert.equal(folded.length, 2, '较早两段分别保留摘要')
      assert.ok(folded.every((row) => !row.expanded))
      assert.ok(
        rows.some((row) => row.itemId === 'n2'),
        '最后一段的说明可见',
      )
      assert.ok(
        rows.some((row) => row.type === 'group'),
        '最后一段的工具组可见',
      )
      // 最后工具和 final 都写完，仍须等回合真正结束才折叠。
      view.items.c2 = { ...view.items.c2, status: 'completed' }
      view.items.final = answer('final', '最终结果')
      view.turns[1].itemIds.push('final')
      assert.ok(builder.build(view, 'all').some((row) => row.itemId === 'n2'))
      view.turns[1].status = 'completed'
      const done = builder.build(view, 'all')
      assert.ok(!done.some((row) => row.itemId === 'n2'))
      assert.ok(done.some((row) => row.type === 'user' && row.key === 'reply'))
    }
  }
})

test('同回合两段最终回答都显示，父会话插话后的短答不折叠调研结论', () => {
  const items = [
    user('question', '请调研'),
    command('research', 'completed', 0),
    answer('conclusion', '完整调研结论'),
    user('peer', '父会话发来补充'),
    command('ack-tool', 'completed', 0),
    answer('ack', '已知悉'),
  ]
  const rows = new RowBuilder().build(
    viewOf(
      [{ id: 'research-turn', status: 'completed', itemIds: items.map((item) => item.id) }],
      items,
    ),
    'all',
  )
  const markdown = rows.filter((row) => row.type === 'md')
  assert.equal(markdown.length, 2)
  assert.ok(JSON.stringify(markdown).includes('完整调研结论'))
  assert.ok(JSON.stringify(markdown).includes('已知悉'))
})

test('独立的后台续做回合结束后保留脚注：过程收起、无最终回答都不省略，下一回合用户消息在脚注之后', () => {
  for (const hasAnswer of [false, true]) {
    const items = [command('bg:c', 'completed', 0)]
    if (hasAnswer) items.push(answer('bg:a', ''))
    const ids = items.map((item) => item.id)
    items.push(user('next:u', '继续检查'))
    const rows = new RowBuilder().build(
      viewOf(
        [
          {
            id: 'bg',
            origin: 'backgroundTask',
            status: 'completed',
            itemIds: ids,
            startedAt: 1000,
            durationMs: 196000,
          },
          { id: 'next', status: 'running', itemIds: ['next:u'] },
        ],
        items,
      ),
      'all',
    )
    const footer = rows.findIndex((row) => row.type === 'status' && row.turnId === 'bg')
    assert.ok(footer > 0)
    assert.equal(rows[footer].status, 'completed')
    assert.equal(rows[footer].startedAt, 1000)
    assert.equal(rows[footer].durationMs, 196000)
    assert.equal(rows[footer + 1].type, 'user')
    assert.equal(rows[footer + 1].turnId, 'next')
    if (hasAnswer) assert.equal(rows[footer - 1].type, 'process')
  }
})

test('经理的四种事件保留来源类型，显示系统事件行而非用户气泡', () => {
  for (const kind of ['manager-open', 'manager-answers', 'manager-end', 'manager-rules']) {
    const text = formatSessionEvent({
      kind,
      notes: [],
      manager: {
        managerId: 'm1',
        text: '处理经理事件',
        ...(kind === 'manager-answers'
          ? {
              answers: [
                {
                  decisionId: 'D-1',
                  title: '范围',
                  optionId: null,
                  optionLabel: null,
                  text: '继续',
                },
              ],
            }
          : {}),
      },
    })
    const item = projectItem({
      type: 'userMessage',
      id: kind,
      content: [{ type: 'text', text, text_elements: [] }],
    })
    const view = viewOf([{ id: 't', status: 'running', itemIds: [kind] }], [item])
    const rows = new RowBuilder().build(view, 'all')
    assert.equal(rows.find((row) => row.type === 'event')?.kind, kind)
    assert.match(rows.find((row) => row.type === 'event')?.body ?? '', /处理经理事件/)
    if (kind === 'manager-answers')
      assert.equal(rows.find((row) => row.type === 'event')?.summary, 'D-1')
    assert.equal(
      rows.some((row) => row.type === 'user'),
      false,
    )
  }
})

test('未知会话事件保留 kind 与正文供通用事件行展开，后续用户原话仍独立显示', () => {
  const text =
    '<litch-session-event kind="future-event">\n未来事件正文\n<!-- {"kind":"future-event","notes":[]} -->\n</litch-session-event>\n继续工作'
  const item = projectItem({
    type: 'userMessage',
    id: 'unknown',
    content: [{ type: 'text', text, text_elements: [] }],
  })
  const rows = new RowBuilder().build(
    viewOf([{ id: 't', status: 'running', itemIds: ['unknown'] }], [item]),
    'all',
  )
  const event = rows.find((row) => row.type === 'event')
  assert.equal(event?.kind, 'future-event')
  assert.equal(event?.body, 'future-event\n\n未来事件正文')
  assert.deepEqual(event?.notes, [])
  assert.equal(rows.find((row) => row.type === 'user')?.text, '继续工作')
})

test('中断后继续走系统行，不画成右侧用户气泡，展开后仍是系统行', () => {
  const prompt = '请核对已经完成的步骤并继续。'
  const text = recoverMessage(prompt)
  const item = projectItem({
    type: 'userMessage',
    id: 'recover',
    content: [{ type: 'text', text, text_elements: [] }],
  })
  const view = viewOf([{ id: 't', status: 'running', itemIds: ['recover'] }], [item])
  const builder = new RowBuilder()
  const rows = builder.build(view, 'all')
  assert.equal(
    rows.some((row) => row.type === 'user'),
    false,
  )
  const system = rows.find((row) => row.type === 'system')
  assert.deepEqual(system.system, { kind: 'recover', prompt })
  builder.toggle(system.key, 't')
  const expanded = builder.build(view, 'all').find((row) => row.type === 'system')
  assert.equal(expanded.expanded, true)
  assert.equal(expanded.text, text)
})

test('重启续跑在手机上显示独立系统来源，展开保留核对副作用的完整指令', () => {
  const text = restartMessage('10203040-5060-4070-8080-102030405060')
  const item = projectItem({
    type: 'userMessage',
    id: 'restart',
    content: [{ type: 'text', text }],
  })
  const view = viewOf([{ id: 't', status: 'running', itemIds: ['restart'] }], [item])
  const builder = new RowBuilder()
  const rows = builder.build(view, 'all')
  assert.equal(
    rows.some((row) => row.type === 'user'),
    false,
  )
  const system = rows.find((row) => row.type === 'system')
  assert.equal(system.system.kind, 'restart')
  builder.toggle(system.key, 't')
  assert.match(
    builder.build(view, 'all').find((row) => row.type === 'system').text,
    /external side effects/,
  )
})

/** 回合结束后整段过程收成一行：点开它（第一次建行之前点就是展开），看过程里的各段 */
const openedBuilder = (turnId = 't') => {
  const builder = new RowBuilder()
  builder.toggle(`${turnId}:process`, turnId)
  return builder
}

test('一个回合：用户消息、收起的过程组、回答、状态行', () => {
  const items = [
    user('u', '你好'),
    command('c1', 'completed', 0),
    command('c2', 'completed', 1),
    answer('a', '好的'),
  ]
  const view = viewOf(
    [{ id: 't', status: 'completed', itemIds: ['u', 'c1', 'c2', 'a'], durationMs: 900 }],
    items.map((item) => (item.kind === 'command' ? { ...item, status: 'completed' } : item)),
  )
  const rows = new RowBuilder().build(view, 'all')
  // 回合结束：整段过程收成一行（照桌面端），写几步、回合用时
  assert.deepEqual(types(rows), ['user', 'process', 'md', 'status'])
  assert.equal(rows[1].key, 't:process')
  assert.equal(rows[1].steps, 2)
  assert.equal(rows[1].expanded, false)
  // 没被补充分段：过程的用时就是回合的用时，只写在状态行上
  assert.equal(rows[1].durationMs, null)
  assert.equal(rows[1].ids, 'c1 c2')
  assert.equal(rows[3].durationMs, 900)
  const open = openedBuilder().build(view, 'all')
  assert.deepEqual(types(open), ['user', 'process', 'group', 'md', 'status'])
  const group = open[2]
  assert.equal(group.count, 2)
  assert.equal(group.failed, 1, '退出码不是 0 的算没成')
  assert.equal(group.running, false)
})

test('正在跑的一步：摘要上说它在做什么；只有说明的一组不折叠', () => {
  const view = viewOf(
    [{ id: 't', status: 'running', itemIds: ['u', 'n', 'c'] }],
    [user('u', '跑'), notice('n'), { ...command('c'), status: 'inProgress' }],
  )
  const rows = new RowBuilder().build(view, 'all')
  // 说明和命令挨着就是同一组；只有说明时单独一行
  assert.deepEqual(types(rows), ['user', 'group', 'status'])
  assert.equal(rows[1].current, 'run c')
  assert.equal(rows[1].since, null, '没记过时刻的不计时')
  // 记过时刻的：累计用时从这一组最早开始的那一条算（在跑的那条还没结束，也要算进去）
  const timed = viewOf(
    [{ id: 't', status: 'running', itemIds: ['u', 'c1', 'c'] }],
    [
      user('u', '跑'),
      { ...command('c1'), status: 'completed', span: { from: 1000, to: 3000 } },
      { ...command('c'), status: 'inProgress', span: { from: 3500, to: null } },
    ],
  )
  assert.equal(new RowBuilder().build(timed, 'all')[1].since, 1000)
  const onlyNotice = viewOf([{ id: 't', status: 'completed', itemIds: ['n'] }], [notice('n')])
  assert.deepEqual(types(new RowBuilder().build(onlyNotice, 'all')), ['notice', 'status'])
})

test('状态行在回合跑时写“正在工作”：只在正文出字、等人答复时留空，步骤在跑照写', () => {
  const working = (items, requests = []) => {
    const view = viewOf(
      [{ id: 't', status: 'running', itemIds: items.map((item) => item.id) }],
      items,
    )
    view.requests = requests
    return new RowBuilder().build(view, 'all').at(-1).working
  }
  assert.equal(working([user('u', '跑')]), true)
  assert.equal(working([user('u', '跑'), answer('a', '先看看')]), true)
  assert.equal(working([user('u', '跑'), answer('a', '正在写', 'inProgress')]), false)
  assert.equal(working([user('u', '跑'), { ...command('c'), status: 'inProgress' }]), true)
  assert.equal(working([user('u', '跑')], [{ id: 'r', kind: 'approval' }]), false)
  const done = viewOf([{ id: 't', status: 'completed', itemIds: ['u'] }], [user('u', '跑')])
  assert.equal(new RowBuilder().build(done, 'all').at(-1).working, false)
})

test('回合在跑、紧挨在上面的是这一回合的活动：状态行不另占一行；正文接着出来、重试、回合结束时照常', () => {
  const last = (items, turn = {}) =>
    new RowBuilder()
      .build(
        viewOf(
          [{ id: 't', status: 'running', itemIds: items.map((item) => item.id), ...turn }],
          items,
        ),
        'all',
      )
      .at(-1)
  const running = { ...command('c'), status: 'inProgress' }
  assert.equal(last([user('u', '跑')]).merged, false)
  assert.equal(last([user('u', '跑'), running]).merged, true)
  assert.equal(last([user('u', '跑'), running, answer('a', '正在写', 'inProgress')]).merged, false)
  assert.equal(
    last([user('u', '跑'), running], {
      retry: { attempt: 2, maxRetries: 5, reason: 'rateLimit', httpStatus: 429 },
    }).merged,
    false,
  )
  const done = viewOf(
    [{ id: 't', status: 'completed', itemIds: ['u', 'c'] }],
    [user('u', '跑'), { ...command('c'), status: 'completed', exitCode: 0 }],
  )
  assert.equal(new RowBuilder().build(done, 'all').at(-1).merged, false)
})

test('最下面的活动、没有一步在跑（模型在想下一步）：“正在工作”接在那一组摘要末尾，从回合开始走秒；行对象照常复用', () => {
  const build = (items, builder = new RowBuilder(), turn = {}) => {
    const view = viewOf(
      [
        {
          id: 't',
          status: 'running',
          startedAt: 1000,
          itemIds: items.map((item) => item.id),
          ...turn,
        },
      ],
      items,
    )
    return builder.build(view, 'all')
  }
  const groups = (rows) => rows.filter((row) => row.type === 'group')
  const done = (id) => ({ ...command(id), status: 'completed', exitCode: 0 })
  // 一步跑完、下一步还没来：在想
  const thinking = build([user('u', '跑'), done('c1')])
  assert.equal(groups(thinking)[0].working, true)
  assert.equal(groups(thinking)[0].turnStartedAt, 1000)
  assert.equal(thinking.at(-1).merged, true)
  // 有一步在跑：摘要写在跑什么，不写“正在工作”
  assert.equal(
    groups(build([user('u', '跑'), { ...command('c'), status: 'inProgress' }]))[0].working,
    false,
  )
  // 活动后面接着出正文：“正在工作”回到状态行（正文出字时留空）
  const writing = build([user('u', '跑'), done('c1'), answer('a', '正在写', 'inProgress')])
  assert.ok(groups(writing).every((row) => !row.working))
  assert.equal(writing.at(-1).merged, false)
  assert.equal(writing.at(-1).working, false)
  const afterWriting = build([
    user('u', '跑'),
    done('c1'),
    { ...answer('n', '先看看'), phase: 'commentary' },
  ])
  assert.equal(groups(afterWriting)[0].working, false)
  assert.equal(afterWriting.at(-1).merged, false)
  assert.equal(afterWriting.at(-1).working, true)
  // 前面一组、中间一段说明、最下面又一组：只有最下面那组写
  const two = build([
    user('u', '跑'),
    done('c1'),
    { ...answer('n', '先看看'), phase: 'commentary' },
    done('c2'),
  ])
  assert.deepEqual(
    groups(two).map((row) => row.working),
    [false, true],
  )
  // 等人答复时不写
  const asking = viewOf(
    [{ id: 't', status: 'running', startedAt: 1000, itemIds: ['u', 'c1'] }],
    [user('u', '跑'), done('c1')],
  )
  asking.requests = [{ id: 'r', kind: 'approval' }]
  assert.equal(groups(new RowBuilder().build(asking, 'all'))[0].working, false)
  // 重试时状态行照写，摘要不写
  assert.equal(
    groups(
      build([user('u', '跑'), done('c1')], new RowBuilder(), {
        retry: { attempt: 2, maxRetries: 5, reason: 'rateLimit', httpStatus: 429 },
      }),
    )[0].working,
    false,
  )
  // 同一份内容再排一次：同一个行对象（只 keep 一次，不来回换）
  const builder = new RowBuilder()
  const items = [user('u', '跑'), done('c1')]
  const first = groups(build(items, builder))[0]
  assert.equal(groups(build(items, builder))[0], first)
  builder.toggle(first.key, 't')
  const expanded = build(items, builder)
  assert.equal(groups(expanded)[0].working, true)
  assert.equal(expanded.at(-2).type, 'groupEnd')
  assert.equal(expanded.at(-1).merged, true)
  // 回合结束：不再写
  const ended = viewOf(
    [{ id: 't', status: 'completed', startedAt: 1000, itemIds: ['u', 'c1'] }],
    [user('u', '跑'), done('c1')],
  )
  assert.equal(groups(new RowBuilder().build(ended, 'all'))[0].working, false)
})

test('展开一组：摘要在前，每一步各一行排在它后面，最后一行“收起”（倒置后往下展开）', () => {
  const items = [user('u', '跑'), { ...command('c1'), status: 'completed', exitCode: 0 }]
  const view = viewOf([{ id: 't', status: 'completed', itemIds: ['u', 'c1'] }], items)
  const builder = openedBuilder()
  const group = builder.build(view, 'all')[1]
  builder.toggle(group.key, 't')
  const rows = builder.build(view, new Set(['t']))
  // 没有最终回答，回合结束了过程也不收，没有收起整段过程的那一行
  assert.deepEqual(types(rows), ['user', 'group', 'step', 'groupEnd', 'status'])
  assert.equal(rows[1].expanded, true)
  assert.equal(rows[2].output, 'c1 的输出')
  assert.equal(rows[2].state, 'done')
  assert.equal(rows[3].group, group.key)
  // 收起：摘要还是原来那个键，步骤和“收起”都没了
  builder.toggle(group.key, 't')
  const folded = builder.build(view, new Set(['t']))
  assert.deepEqual(types(folded), ['user', 'group', 'status'])
  assert.equal(folded[1].key, group.key)
})

/** 启动子代理、等待子代理的协作调用（核心投影出来的样子） */
const collab = (id, tool, agents, status = 'completed') => ({
  id,
  kind: 'toolCall',
  source: { key: 'collab.source' },
  tool: { key: `collab.${tool}` },
  status,
  input: tool === 'spawnAgent' ? [{ kind: 'text', text: '分头查三件事。第一件看目录' }] : [],
  output: [],
  error: null,
  durationMs: null,
  agents,
})

test('Codex 活动与协作调用共用子代理行，状态更新不增加行，历史回放也不重复', () => {
  const activity = (id, kind) =>
    projectItem({
      type: 'subAgentActivity',
      id,
      kind,
      agentThreadId: 'a1',
      agentPath: '/root/review',
      model: null,
      reasoningEffort: null,
    })
  const start = activity('start', 'started')
  const done = activity('done', 'completed')
  const items = [user('u', '审核'), start]
  const view = viewOf(
    [{ id: 't', status: 'running', itemIds: items.map((item) => item.id) }],
    items,
  )
  const builder = openedBuilder()
  const first = builder.build(view, 'all')
  assert.equal(first.filter((row) => row.type === 'agents').length, 1)
  assert.equal(first.find((row) => row.type === 'agents').states, 'running')
  view.items.done = done
  view.turns[0].itemIds.push('done')
  const updated = builder.build(view, new Set(['t']))
  assert.equal(updated.filter((row) => row.type === 'agents').length, 1)
  assert.equal(updated.find((row) => row.type === 'agents').states, 'completed')
  const spawn = collab('sp', 'spawnAgent', [{ threadId: 'a1', state: 'running', message: null }])
  view.items.sp = spawn
  view.turns[0].itemIds.splice(1, 0, 'sp')
  const replay = new RowBuilder().build(view, 'all')
  const rows = replay.filter((row) => row.type === 'agents')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].item.id, 'sp')
  assert.equal(rows[0].states, 'completed')
  assert.ok(!replay.some((row) => row.type === 'notice' || row.type === 'group'))
})

test('启动子代理不进过程组，单独一行；等待还是组里的一步', () => {
  const spawn = collab('sp', 'spawnAgent', [
    { threadId: 'a1', state: 'running', message: null },
    { threadId: 'a2', state: 'running', message: null },
    { threadId: 'a3', state: 'running', message: null },
  ])
  const wait = collab('w', 'wait', [
    { threadId: 'a1', state: 'completed', message: null },
    { threadId: 'a2', state: 'interrupted', message: null },
    { threadId: 'a3', state: 'errored', message: null },
  ])
  const items = [user('u', '用子代理'), spawn, wait, answer('a', '都停下了')]
  const view = viewOf([{ id: 't', status: 'completed', itemIds: ['u', 'sp', 'w', 'a'] }], items)
  view.agents = []
  const builder = openedBuilder()
  const all = builder.build(view, 'all')
  assert.deepEqual(types(all), ['user', 'process', 'agents', 'group', 'md', 'status'])
  assert.equal(all[1].agents, 3)
  assert.equal(all[1].agentsFailed, 1, '出错的子代理在收起行上标红')
  const rows = all.filter((row) => row.type !== 'process')
  assert.equal(rows[1].item, spawn)
  // 子线程还没列出来：按等待那一条报的状态
  assert.equal(rows[1].states, 'completed stopped failed')
  assert.equal(rows[2].count, 1)
  assert.equal(rows[2].ids, 'w')
  // 子线程自己的回合优先：列表来了以后按它写
  view.agents = [
    {
      id: 'a1',
      status: 'idle',
      turn: { state: 'failed', startedAt: 1, durationMs: 5, error: 'x' },
    },
    { id: 'a2', status: 'running', turn: { state: 'running', startedAt: 1, durationMs: null } },
  ]
  const again = builder.build(view, new Set(['t']))
  assert.equal(again[2].states, 'failed running failed')
  assert.equal(again[2].threads, view.agents)
  // 内容没变的行复用同一个对象
  assert.equal(builder.build(view, new Set(['t']))[2], again[2])
})

test('启动子代理刚开始、还不知道派了谁：也是单独一行，没有状态', () => {
  const spawn = collab('sp', 'spawnAgent', [], 'inProgress')
  const items = [user('u', '用子代理'), command('c1', 'completed', 0), spawn]
  const view = viewOf(
    [{ id: 't', status: 'running', itemIds: ['u', 'c1', 'sp'] }],
    items.map((item) => (item.kind === 'command' ? { ...item, status: 'completed' } : item)),
  )
  view.agents = []
  const rows = new RowBuilder().build(view, 'all')
  assert.deepEqual(types(rows), ['user', 'group', 'agents', 'status'])
  assert.equal(rows[1].count, 1)
  assert.equal(rows[2].states, '')
})

test('没动过的回合原样复用；动过的回合里没变的行还是同一个对象', () => {
  const items = [
    user('u1', '一'),
    answer('a1', '甲'),
    user('u2', '二'),
    answer('a2', '乙', 'inProgress'),
  ]
  const view = viewOf(
    [
      { id: 't1', status: 'completed', itemIds: ['u1', 'a1'] },
      { id: 't2', status: 'running', itemIds: ['u2', 'a2'] },
    ],
    items,
  )
  const builder = new RowBuilder()
  const first = builder.build(view, 'all')
  view.items.a2 = { ...view.items.a2, text: '乙乙乙' }
  const second = builder.build(view, new Set(['t2']))
  assert.equal(second.length, first.length)
  // 第一个回合三行、第二个回合的用户消息：都没变
  for (const index of [0, 1, 2, 3]) assert.equal(second[index], first[index], `第 ${index} 行复用`)
  assert.notEqual(second[4], first[4], '在长的回答换了一行')
  assert.equal(second[4].text, '乙乙乙')
  assert.equal(second[4].live, true)
  assert.equal(second[5], first[5], '状态行没变')
  // 回合结束：状态行的键不变、内容换了
  view.turns[1].status = 'completed'
  view.items.a2 = { ...view.items.a2, status: 'completed' }
  const third = builder.build(view, new Set(['t2']))
  assert.equal(third[5].key, first[5].key)
  assert.equal(third[5].status, 'completed')
  assert.equal(third[4].live, false)
})

test('失败的回合在状态行上面带一行原因；被删掉的回合不再出行', () => {
  const view = viewOf(
    [
      { id: 't1', status: 'failed', itemIds: ['u1'], error: '模型报错了' },
      { id: 't2', status: 'interrupted', itemIds: ['u2'], error: '不画' },
    ],
    [user('u1', '一'), user('u2', '二')],
  )
  const builder = new RowBuilder()
  assert.deepEqual(types(builder.build(view, 'all')), ['user', 'error', 'status', 'user', 'status'])
  view.turns.shift()
  assert.deepEqual(types(builder.build(view, 'all')), ['user', 'status'])
})

test('分叉来的会话最上面一行说从哪来', () => {
  const view = { ...viewOf([], []), forkedFrom: '原来的会话' }
  assert.deepEqual(new RowBuilder().build(view, 'all'), [
    { type: 'forked', key: 'forked', from: '原来的会话' },
  ])
})

test('后台任务：回合结束了还在跑的步骤不再写“正在做”，摘要带条目号给单元格数；自发回合开头一行在最前', () => {
  const view = viewOf(
    [
      { id: 't1', status: 'completed', itemIds: ['t1:u', 't1:c', 't1:a'] },
      { id: 't2', status: 'running', itemIds: ['t2:a'], origin: 'backgroundTask', startedAt: 9000 },
    ],
    [
      user('t1:u', '后台跑'),
      { ...command('t1:c'), status: 'inProgress' },
      answer('t1:a', '在后台跑着了'),
      answer('t2:a', '跑完了', 'inProgress'),
    ],
  )
  const folded = new RowBuilder().build(view, 'all')
  assert.deepEqual(types(folded), ['user', 'process', 'md', 'status', 'origin', 'md', 'status'])
  assert.equal(folded[1].ids, 't1:c', '收起行带条目号给单元格数后台在跑的')
  const rows = openedBuilder('t1').build(view, 'all')
  assert.deepEqual(types(rows), [
    'user',
    'process',
    'group',
    'md',
    'status',
    'origin',
    'md',
    'status',
  ])
  const group = rows[2]
  assert.equal(group.current, null, '回合结束了：还 inProgress 的是后台命令，不当成正在做的一步')
  assert.equal(group.running, false)
  assert.equal(group.ended, true)
  assert.equal(group.ids, 't1:c')
  assert.deepEqual(rows[5], {
    type: 'origin',
    key: 't2:origin',
    turnId: 't2',
    origin: 'backgroundTask',
    startedAt: 9000,
  })
})

test('上下文压缩：一条单独的分隔行，不进过程组；压的时候状态行不写“正在工作”', () => {
  const compaction = (status, span) => ({
    id: 'k',
    kind: 'compaction',
    status,
    source: 'automatic',
    ...(span ? { span } : {}),
  })
  const running = viewOf(
    [{ id: 't', status: 'running', itemIds: ['u', 'c1', 'k'] }],
    [
      user('u', '接着做'),
      { ...command('c1'), status: 'completed' },
      compaction('inProgress', { from: 5, to: null }),
    ],
  )
  const rows = new RowBuilder().build(running, 'all')
  assert.deepEqual(types(rows), ['user', 'group', 'compaction', 'status'])
  assert.deepEqual(
    { status: rows[2].status, source: rows[2].source, startedAt: rows[2].startedAt },
    { status: 'inProgress', source: 'automatic', startedAt: 5 },
  )
  assert.equal(rows[3].working, false)
  const done = viewOf(
    [{ id: 't', status: 'completed', itemIds: ['k'] }],
    [{ ...compaction('completed'), source: 'manual' }],
  )
  const after = new RowBuilder().build(done, 'all')
  assert.deepEqual(types(after), ['compaction', 'status'])
  assert.deepEqual(
    [after[0].status, after[0].source, after[0].startedAt],
    ['completed', 'manual', null],
  )
})

const thought = (id, text, status = 'completed') => ({ id, kind: 'reasoning', text, status })
const note = (id, text) => ({
  id,
  kind: 'agentMessage',
  text,
  phase: 'commentary',
  status: 'completed',
})

test('思考是步骤组里的一步：不把组拆开、不算步数；在想时摘要写它的第一行（和桌面端同一份分块）', () => {
  const items = [
    user('u', '查一下'),
    thought('r1', '先看目录'),
    { ...command('c1'), status: 'completed', exitCode: 0 },
    thought('r2', '再看配置\n第二行'),
    { ...command('c2'), status: 'completed', exitCode: 0 },
    thought('r3', '想想下一步\n细节', 'inProgress'),
  ]
  const view = viewOf(
    [{ id: 't', status: 'running', itemIds: items.map((item) => item.id) }],
    items,
  )
  const builder = new RowBuilder()
  const rows = builder.build(view, 'all')
  assert.deepEqual(types(rows), ['user', 'group', 'status'], '思考不再单独成行把组切碎')
  assert.equal(rows[1].count, 2, '思考不算步数')
  assert.equal(rows[1].current, '想想下一步')
  assert.equal(rows[1].thinking, true)
  assert.equal(rows[1].ids, 'r1 c1 r2 c2 r3')
  // 展开：思考和步骤按先后各一行
  builder.toggle(rows[1].key, 't')
  const open = builder.build(view, new Set(['t']))
  assert.deepEqual(types(open), [
    'user',
    'group',
    'reasoning',
    'step',
    'reasoning',
    'step',
    'reasoning',
    'groupEnd',
    'status',
  ])
  // 只有思考的一组（两段说明之间只想了想）：不收成摘要，每条一行；没字的思考不画
  const only = [user('u', '想想'), thought('r1', '只是想想'), thought('r2', '', 'completed')]
  const plain = viewOf([{ id: 't', status: 'running', itemIds: ['u', 'r1', 'r2'] }], only)
  assert.deepEqual(types(new RowBuilder().build(plain, 'all')), ['user', 'reasoning', 'status'])
})

test('过程收起：回合结束整段收成一行；说明段在过程里；用户展开过、子代理没做完时不自动收；点那一行开合', () => {
  const items = [
    user('u', '修一下'),
    note('n1', '我先跑测试'),
    thought('r1', '看看结果'),
    { ...command('c1'), status: 'completed', exitCode: 1 },
    note('n2', '再改代码'),
    { ...command('c2'), status: 'declined', exitCode: null },
    answer('a', '修好了'),
  ]
  const ids = items.map((item) => item.id)
  const running = viewOf(
    [{ id: 't', status: 'running', itemIds: ids }],
    [...items.slice(0, -1), answer('a', '修好', 'inProgress')],
  )
  const builder = new RowBuilder()
  // 回合在跑、回答还在写：过程摊开，说明是正文
  assert.deepEqual(types(builder.build(running, 'all')), [
    'user',
    'md',
    'group',
    'md',
    'group',
    'md',
    'status',
  ])
  // 回答写完了也可能继续处理插话，最后一段等回合结束再收起。
  const answered = viewOf([{ id: 't', status: 'running', itemIds: ids }], items)
  assert.deepEqual(types(builder.build(answered, 'all')), types(builder.build(running, 'all')))
  const done = viewOf([{ id: 't', status: 'failed', itemIds: ids, durationMs: 4000 }], items)
  const rows = builder.build(done, 'all')
  assert.deepEqual(types(rows), ['user', 'process', 'md', 'status'])
  assert.deepEqual(
    {
      notes: rows[1].notes,
      steps: rows[1].steps,
      declined: rows[1].declined,
      status: rows[1].status,
      durationMs: rows[1].durationMs,
    },
    { notes: 2, steps: 2, declined: 1, status: 'failed', durationMs: null },
  )
  // 点开、再点收起
  builder.toggle('t:process', 't')
  const open = builder.build(done, new Set(['t']))
  assert.deepEqual(types(open), ['user', 'process', 'md', 'group', 'md', 'group', 'md', 'status'])
  assert.equal(open[1].expanded, true)
  builder.toggle('t:process', 't')
  assert.deepEqual(types(builder.build(done, new Set(['t']))), ['user', 'process', 'md', 'status'])

  // 回合进行中用户展开过某一组：结束时不自动收
  const touched = new RowBuilder()
  const live = touched.build(running, 'all')
  touched.toggle(live[2].key, 't')
  touched.toggle(live[2].key, 't')
  const after = touched.build(done, 'all')
  assert.equal(after[1].type, 'process')
  assert.equal(after[1].expanded, true, '展开过（收起了也算）：结束时照开着')
  assert.ok(after.some((row) => row.type === 'group'))

  // 回合里还有子代理没做完：不自动收
  const spawn = collab('sp', 'spawnAgent', [{ threadId: 'a1', state: 'running', message: null }])
  const withAgent = viewOf(
    [{ id: 't', status: 'completed', itemIds: ['u', 'sp', 'a'] }],
    [user('u', '派出去'), spawn, answer('a', '派出去了')],
  )
  withAgent.agents = [
    { id: 'a1', status: 'running', turn: { state: 'running', startedAt: 1, durationMs: null } },
  ]
  const agentRows = new RowBuilder().build(withAgent, 'all')
  assert.deepEqual(types(agentRows), ['user', 'process', 'agents', 'md', 'status'])
  assert.equal(agentRows[1].expanded, true)
})

test('被打断的回合不收（照 Codex 桌面端）：中途插的话之间的过程、写了一半的回答都摊着；没有最终回答的回合结束了也不收', () => {
  const items = [
    user('u', '看看目录再改'),
    note('n1', '先看目录'),
    { ...command('c1'), status: 'completed', exitCode: 0 },
    user('u2', '顺便看下测试'),
    { ...command('c2'), status: 'completed', exitCode: 0 },
    { ...answer('a', '接下来要改的是'), phase: 'unknown' },
  ]
  const ids = items.map((item) => item.id)
  const stopped = viewOf(
    [{ id: 't', status: 'interrupted', itemIds: ids, durationMs: 9000 }],
    items,
  )
  assert.deepEqual(types(new RowBuilder().build(stopped, 'all')), [
    'user',
    'md',
    'group',
    'user',
    'group',
    'md',
    'status',
  ])
  // 同样的条目、回合正常结束：按补充位置分段，unknown 正文所在段保留工具摘要
  const done = viewOf([{ id: 't', status: 'completed', itemIds: ids }], items)
  assert.deepEqual(types(new RowBuilder().build(done, 'all')), [
    'user',
    'process',
    'user',
    'process',
    'group',
    'md',
    'status',
  ])
  // 没有最终回答（最后一条是过程说明）：结束了也摊着
  const quiet = viewOf(
    [{ id: 't', status: 'completed', itemIds: ['u', 'n1', 'c1'] }],
    items.slice(0, 3),
  )
  assert.deepEqual(types(new RowBuilder().build(quiet, 'all')), ['user', 'md', 'group', 'status'])
})

test('问用户的工具（AskUserQuestion 等）：一张问答卡片，露在过程外面，过程收起时还在', () => {
  const asked = {
    questions: [
      {
        header: '范围',
        question: '装在哪？',
        options: [],
        answer: '系统级',
        picked: [],
        other: '系统级',
      },
    ],
    raw: null,
  }
  const ask = {
    id: 'q',
    kind: 'toolCall',
    source: 'claude',
    tool: 'AskUserQuestion',
    input: [],
    output: [],
    error: null,
    durationMs: 5,
    status: 'completed',
    asked,
  }
  const items = [
    user('u', '先问我'),
    { ...command('c1'), status: 'completed', exitCode: 0 },
    ask,
    { ...command('c2'), status: 'completed', exitCode: 0 },
    answer('a', '照你说的装好了'),
  ]
  const view = viewOf(
    [{ id: 't', status: 'completed', itemIds: items.map((item) => item.id) }],
    items,
  )
  const rows = new RowBuilder().build(view, 'all')
  assert.deepEqual(types(rows), ['user', 'process', 'asked', 'md', 'status'])
  assert.equal(rows[2].item, ask)
  assert.equal(rows[1].steps, 2, '提问不算进过程的步数')
})

test('发送时刻：回合开头那条用户消息带回合开始的时刻，插进来的不带', () => {
  const view = viewOf(
    [
      {
        id: 't',
        status: 'completed',
        startedAt: 1_000,
        durationMs: 500,
        itemIds: ['u', 'a', 'u2'],
      },
      { id: 't2', status: 'completed', itemIds: ['u3'] },
    ],
    [user('u', '先问'), answer('a', '答'), user('u2', '插一句'), user('u3', '没给时刻')],
  )
  const rows = new RowBuilder().build(view, 'all')
  const users = rows.filter((row) => row.type === 'user')
  assert.deepEqual(
    users.map((row) => [row.key, row.sentAt]),
    [
      ['u', 1_000],
      ['u2', undefined],
      ['u3', undefined],
    ],
  )
})

test('零次、一次、多次补充：每段独立开合，计数、总脚注和来源不重复', () => {
  for (const origin of [undefined, 'backgroundTask']) {
    for (const count of [0, 1, 2]) {
      const items = origin ? [] : [user('u0', '开头')]
      for (let i = 0; i <= count; i++) {
        if (i > 0) items.push(user(`u${i}`, '补充'))
        items.push(
          { ...answer(`n${i}`, '说明'), phase: 'commentary' },
          command(`c${i}`, 'completed', 0),
        )
      }
      items.push(answer('a', '最终回答'))
      const view = viewOf(
        [
          {
            id: 't',
            status: 'completed',
            origin,
            durationMs: 196000,
            itemIds: items.map((i) => i.id),
          },
        ],
        items,
      )
      const builder = new RowBuilder()
      const rows = builder.build(view, 'all')
      const heads = rows.filter((r) => r.type === 'process')
      assert.equal(heads.length, count + 1)
      assert.deepEqual(
        heads.map((r) => [r.notes, r.steps]),
        Array.from({ length: count + 1 }, () => [1, 1]),
      )
      // 分了段的各段没记全起止时刻，不写；没分段的用时就是回合的，写在状态行上
      assert.ok(heads.every((r) => r.durationMs === null))
      assert.equal(rows.filter((r) => r.type === 'status').length, 1)
      assert.equal(rows.at(-1).type, 'status')
      assert.equal(rows.filter((r) => r.type === 'origin').length, origin ? 1 : 0)
      assert.deepEqual(
        rows.filter((r) => r.type === 'user').map((r) => r.addition === true),
        origin ? Array(count).fill(true) : [false, ...Array(count).fill(true)],
      )
      builder.toggle(heads.at(-1).key, 't')
      const opened = builder.build(view, 'all').filter((r) => r.type === 'process')
      assert.deepEqual(
        opened.map((r) => r.expanded),
        Array.from({ length: count + 1 }, (_, i) => i === count),
      )
    }
  }
})

test('补充后没有最终回答、仍进行中或被中断：过程保持展开，补充标注保留', () => {
  for (const status of ['completed', 'running', 'interrupted']) {
    const items = [command('c1', 'completed', 0), user('u', '补充'), command('c2', 'completed', 0)]
    const rows = new RowBuilder().build(
      viewOf(
        [{ id: 't', origin: 'backgroundTask', status, itemIds: items.map((i) => i.id) }],
        items,
      ),
      'all',
    )
    assert.equal(
      rows.some((r) => r.type === 'process'),
      false,
    )
    assert.equal(rows.find((r) => r.type === 'user').addition, true)
    assert.equal(rows.filter((r) => r.type === 'group').length, 2)
    assert.equal(rows.at(-1).type, 'status')
  }
})

test('R2 回合形状：3 段说明 6 步、补充、5 段说明 10 步、长回答、完成', () => {
  const items = []
  const process = (prefix, notes, steps) => {
    for (let i = 0; i < notes; i++)
      items.push({ ...answer(`${prefix}n${i}`, '说明'), phase: 'commentary' })
    for (let i = 0; i < steps; i++) items.push(command(`${prefix}c${i}`, 'completed', 0))
  }
  process('b', 3, 6)
  items.push(user('u', '为什么又倒了，人物有防御吗'))
  process('a', 5, 10)
  items.push(answer('final', '有防御。'.repeat(300)))
  const rows = new RowBuilder().build(
    viewOf(
      [
        {
          id: 't',
          origin: 'backgroundTask',
          status: 'completed',
          durationMs: 196000,
          itemIds: items.map((i) => i.id),
        },
      ],
      items,
    ),
    'all',
  )
  assert.deepEqual(types(rows).slice(0, 4), ['origin', 'process', 'user', 'process'])
  assert.deepEqual(
    rows.filter((r) => r.type === 'process').map((r) => [r.notes, r.steps]),
    [
      [3, 6],
      [5, 10],
    ],
  )
  assert.equal(rows.at(-1).durationMs, 196000)
  assert.ok(rows.slice(4, -1).every((r) => r.type === 'md'))
})
