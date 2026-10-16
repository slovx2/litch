import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { approvalKind, type ToolCallAsk } from '../src/approvals.mjs'
import { harnessDeclaration } from '../src/declaration.mjs'
import { approvalHarness, pause, toolResults } from './approval-harness.mjs'

// Pi 的审批（设计文档 03 第八节 A5）：由设置打开，默认不问。这个文件看一条连接上的事：
// 声明、哪些调用被拦下、四种决定各自的结果、差异。等待、作废、多条连接、别的工具在 approvals-flow.test.mts。

const MODEL = 'gate/gate'
const statuses = (connection: { notifications(method: string): any[] }, from = 0) =>
  connection
    .notifications('thread/status/changed')
    .slice(from)
    .map((m) => m.params.status)

test('APPROVAL-001：打开审批后的声明：两类审批、覆盖不到子代理、收“拒绝并附说明”，会话报的审批策略跟着变', {
  timeout: 60000,
}, async () => {
  const h = await approvalHarness()
  try {
    const c = await h.connect('desktop')
    const info = await c.ok('runtime/info')
    const { displayName, badge, extensions, features, permissionPresets } = info
    assert.deepEqual(
      { displayName, badge, extensions, features, permissionPresets },
      harnessDeclaration(true),
    )
    assert.deepEqual(features.approvals, {
      kinds: ['command', 'fileChange'],
      uncovered: ['subagents'],
    })
    assert.deepEqual(extensions, ['declineWithNote', 'planConfirmation'])
    // 还是只有“完全访问”一档（没有沙箱），说明里交代问什么、哪里不问、不是安全边界。
    assert.deepEqual(
      permissionPresets.map((preset: any) => [preset.id, preset.risk, preset.switchInSession]),
      [[':danger-full-access', 'high', false]],
    )
    const said = permissionPresets[0].description
    assert.match(said['zh-CN'], /没有沙箱/)
    assert.match(said['zh-CN'], /之前先问你/)
    assert.match(said['zh-CN'], /子代理里的操作不问/)
    assert.match(said['zh-CN'], /不是安全边界/)
    assert.match(said.en, /No sandbox/)
    assert.match(said.en, /inside subagents are not asked about/)
    assert.match(said.en, /not a security boundary/)
    // 除了审批相关的两处，别的能力位和没打开时一样。
    const off = harnessDeclaration(false)
    assert.deepEqual({ ...features, approvals: null }, { ...off.features, approvals: null })
    assert.deepEqual(off.features?.approvals, { kinds: [], uncovered: [] })
    assert.deepEqual(off.extensions, ['planConfirmation'])
    assert.match(off.permissionPresets?.[0]?.description['zh-CN'] ?? '', /也不询问/)

    const started = await c.ok('thread/start', { cwd: h.cwd, model: MODEL })
    assert.equal(started.approvalPolicy, 'untrusted')
    assert.equal(started.thread.activePermissionProfile, ':danger-full-access')
    assert.deepEqual(started.sandbox, { type: 'dangerFullAccess' })
    assert.equal((await c.ok('config/read')).config.approval_policy, 'untrusted')
    // 钩子排在所有扩展的最后：别的扩展先拦下的调用就不用来问用户。
    const loaded = h.server.sessions.get(started.thread.id)?.loader.getExtensions().extensions ?? []
    assert.equal(loaded.at(-1)?.path, '<inline:codex-harness-adapter-approvals>')
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('APPROVAL-002：没打开审批（默认）时 Pi 那边不挂钩子，命令、写文件、改文件都直接执行，一条请求都不发', {
  timeout: 60000,
}, async () => {
  const h = await approvalHarness({ approvals: false })
  try {
    const c = await h.connect('desktop', ['declineWithNote'])
    const started = await c.ok('thread/start', { cwd: h.cwd, model: MODEL })
    const threadId = started.thread.id
    assert.equal(started.approvalPolicy, 'never')
    assert.equal((await c.ok('config/read')).config.approval_policy, 'never')
    const loaded = h.server.sessions.get(threadId)?.loader.getExtensions().extensions ?? []
    assert.equal(
      loaded.some((extension) => extension.path.includes('codex-harness-adapter-approvals')),
      false,
      'Pi 的扩展清单里没有审批这一项',
    )
    await writeFile(join(h.cwd, 'doc.txt'), 'alpha\nbeta\n')
    h.steps.push({
      tools: [
        { name: 'bash', args: { command: 'touch ran.txt' } },
        { name: 'write', args: { path: join(h.cwd, 'new.txt'), content: 'NEW\n' } },
        {
          name: 'edit',
          args: { path: join(h.cwd, 'doc.txt'), edits: [{ oldText: 'beta', newText: 'BETA' }] },
        },
      ],
    })
    const turn = await c.completed(await c.start(threadId, '都做一遍'))
    assert.equal(turn.status, 'completed', JSON.stringify(turn.error))
    assert.equal(existsSync(join(h.cwd, 'ran.txt')), true)
    assert.equal(readFileSync(join(h.cwd, 'new.txt'), 'utf8'), 'NEW\n')
    assert.equal(readFileSync(join(h.cwd, 'doc.txt'), 'utf8'), 'alpha\nBETA\n')
    assert.deepEqual(
      c.messages.filter((m) => m.method && m.id !== undefined).map((m) => m.method),
      [],
      '没有任何服务端请求',
    )
    assert.deepEqual(c.notifications('serverRequest/resolved'), [])
    assert.deepEqual(c.notifications('item/fileChange/patchUpdated'), [], '不预先算差异')
    assert.deepEqual(statuses(c), [{ type: 'active', activeFlags: [] }, { type: 'idle' }])
    assert.deepEqual(
      turn.items
        .filter((item: any) => item.type !== 'agentMessage')
        .map((item: any) => item.status),
      [undefined, 'completed', 'completed', 'completed'],
    )
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('APPROVAL-003：命令先问再跑：允许这一次、拒绝、这个会话里都允许、取消', {
  timeout: 90000,
}, async () => {
  const h = await approvalHarness()
  try {
    const c = await h.connect('desktop')
    const threadId = (await c.ok('thread/start', { cwd: h.cwd, model: MODEL })).thread.id
    const file = (name: string) => join(h.cwd, name)
    const bash = (command: string) => ({ tools: [{ name: 'bash', args: { command } }] })

    // 允许这一次：答复之前命令没跑，答复之后跑了。
    h.steps.push(bash('touch once.txt'))
    const mark = c.notifications('thread/status/changed').length
    const first = await c.start(threadId, '跑一条命令')
    const asked = await c.approval()
    assert.equal(asked.method, 'item/commandExecution/requestApproval')
    assert.deepEqual(asked.params, {
      threadId,
      turnId: first,
      itemId: asked.params.itemId,
      startedAtMs: asked.params.startedAtMs,
      reason: null,
      kind: 'command',
      approvalId: null,
      environmentId: null,
      command: 'touch once.txt',
      cwd: h.cwd,
      commandActions: [],
      additionalPermissions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    })
    assert.equal(typeof asked.params.startedAtMs, 'number')
    // 请求指着的条目在这之前已经开始了。
    const begun = c.messages.findIndex(
      (m) => m.method === 'item/started' && m.params.item.id === asked.params.itemId,
    )
    assert.ok(begun >= 0 && begun < c.messages.indexOf(asked))
    assert.equal(c.messages[begun].params.item.type, 'commandExecution')
    assert.equal(existsSync(file('once.txt')), false, '答复之前命令没有跑')
    assert.deepEqual(statuses(c, mark).at(-1), {
      type: 'active',
      activeFlags: ['waitingOnApproval'],
    })
    assert.deepEqual((await c.ok('thread/read', { threadId, includeTurns: false })).thread.status, {
      type: 'active',
      activeFlags: ['waitingOnApproval'],
    })
    await c.decide(asked, 'accept')
    assert.equal((await c.completed(first)).status, 'completed')
    assert.equal(existsSync(file('once.txt')), true)
    assert.equal(c.item(asked.params.itemId).status, 'completed')
    assert.deepEqual(statuses(c, mark), [
      { type: 'active', activeFlags: [] },
      { type: 'active', activeFlags: ['waitingOnApproval'] },
      { type: 'active', activeFlags: [] },
      { type: 'idle' },
    ])
    assert.deepEqual(
      c.notifications('serverRequest/resolved').map((m) => m.params),
      [{ threadId, requestId: asked.id }],
    )

    // 拒绝：命令没跑，回合继续，理由到了模型手里，条目是“已否决”。
    let seen: string[] = []
    h.steps.push(bash('touch never.txt'), (body) => {
      seen = toolResults(body)
      return { text: '那就不跑了' }
    })
    const second = await c.start(threadId, '再跑一条')
    const refused = await c.approval()
    await c.decide(refused, 'decline')
    const declinedTurn = await c.completed(second)
    assert.equal(declinedTurn.status, 'completed')
    assert.equal(existsSync(file('never.txt')), false)
    assert.equal(seen.at(-1), 'denied by user')
    assert.equal(declinedTurn.items.at(-1).text, '那就不跑了')
    const live = c.item(refused.params.itemId)
    assert.deepEqual([live.status, live.exitCode, live.aggregatedOutput], ['declined', null, null])
    // 重新载入会话（历史从原生会话文件投影）之后还是“已否决”。
    await c.ok('thread/resume', { threadId })
    const reloaded = (await c.ok('thread/read', { threadId })).thread.turns
      .flatMap((turn: any) => turn.items)
      .find((item: any) => item.id === refused.params.itemId)
    assert.deepEqual(
      [reloaded.type, reloaded.status, reloaded.exitCode, reloaded.aggregatedOutput],
      ['commandExecution', 'declined', null, null],
    )

    // 这个会话里都允许：同一条命令不再问，换一条照样问。
    h.steps.push(bash('touch again.txt'))
    const third = await c.start(threadId, '以后都行')
    await c.decide(await c.approval(), 'acceptForSession')
    await c.completed(third)
    assert.equal(existsSync(file('again.txt')), true)
    const before = c.approvals().length
    h.steps.push(bash('touch again.txt'), bash('touch other.txt'))
    const fourth = await c.start(threadId, '同一条再来，再换一条')
    const different = await c.approval()
    assert.equal(different.params.command, 'touch other.txt', '同一条命令没有再问')
    assert.equal(existsSync(file('other.txt')), false)
    await c.decide(different, 'accept')
    await c.completed(fourth)
    assert.equal(existsSync(file('other.txt')), true)
    assert.equal(c.approvals().length, before + 1)

    // 取消：命令没跑，回合跟着被打断，模型不再被请求。
    h.steps.push(bash('touch cancelled.txt'))
    const requested = h.requests.length
    const fifth = await c.start(threadId, '这条取消')
    const cancelled = await c.approval()
    await c.decide(cancelled, 'cancel')
    assert.equal((await c.completed(fifth)).status, 'interrupted')
    await pause(200)
    assert.equal(existsSync(file('cancelled.txt')), false)
    assert.equal(c.item(cancelled.params.itemId).status, 'declined')
    assert.equal(h.requests.length, requested + 1, '取消之后没有再请求模型')
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

// 分类只看工具的来源和标注，不看名字：扩展注册的同名工具不会被当成内置的放行。
test('APPROVAL-004：工具怎么分类', () => {
  const ask = (toolName: string, source: string | null, extra: Partial<ToolCallAsk> = {}) =>
    approvalKind(
      {
        toolCallId: 'call',
        toolName,
        input: {},
        source,
        annotations: undefined,
        managed: false,
        signal: undefined,
        ...extra,
      },
      false,
    )
  for (const name of ['read', 'grep', 'find', 'ls', 'tool-search', 'codemode'])
    assert.equal(ask(name, `builtin:${name}`), null, name)
  assert.equal(ask('bash', 'builtin:bash'), 'command')
  assert.equal(ask('powershell', 'builtin:powershell'), 'command')
  assert.equal(ask('edit', 'builtin:edit'), 'fileChange')
  assert.equal(ask('write', 'builtin:write'), 'fileChange')
  // 顶掉内置工具的同名扩展工具、登记里查不到的工具、没有标注的 MCP 工具：都问。
  assert.equal(ask('read', '/home/me/.pi/agent/extensions/read.ts'), 'tool')
  assert.equal(ask('bash', '/home/me/.pi/agent/extensions/bash.ts'), 'tool')
  assert.equal(ask('mystery', null), 'tool')
  assert.equal(ask('mcp__docs__search', 'builtin:mcp'), 'tool')
  // 标注：和 codex 判断 MCP 工具的式子一样。
  const hinted = (annotations: ToolCallAsk['annotations']) =>
    ask('mcp__docs__tool', 'builtin:mcp', { annotations })
  assert.equal(hinted({ readOnlyHint: true }), null)
  assert.equal(hinted({ readOnlyHint: true, destructiveHint: true }), 'tool')
  assert.equal(hinted({ readOnlyHint: false }), 'tool')
  assert.equal(hinted({ destructiveHint: false }), 'tool', '还可能碰到外面的世界')
  assert.equal(hinted({ destructiveHint: false, openWorldHint: false }), null)
  // 随适配器分发的插件：提问、交计划、取结果不问；启动子代理、给子代理追加指示要问。
  const managed = (name: string) => ask(name, '/adapter/plugin.ts', { managed: true })
  for (const name of ['plan_mode_question', 'plan_mode_complete', 'get_subagent_result'])
    assert.equal(managed(name), null, name)
  assert.equal(managed('subagent'), 'tool')
  assert.equal(managed('steer_subagent'), 'tool')
  // 名字相同但不是随适配器分发的那个：照标注问。
  assert.equal(ask('plan_mode_complete', '/home/me/.pi/agent/extensions/x.ts'), 'tool')
  // 客户端注册、由客户端执行的工具不问。
  assert.equal(
    approvalKind(
      {
        toolCallId: 'call',
        toolName: 'client_x',
        input: {},
        source: '<sdk:client_x>',
        annotations: undefined,
        managed: false,
        signal: undefined,
      },
      true,
    ),
    null,
  )
})

test('APPROVAL-005：写文件、改文件先问，差异对着磁盘上的现状算好放在条目上', {
  timeout: 90000,
}, async () => {
  const h = await approvalHarness()
  try {
    const c = await h.connect('desktop')
    const threadId = (await c.ok('thread/start', { cwd: h.cwd, model: MODEL })).thread.id
    const path = (name: string) => join(h.cwd, name)
    const write = (name: string, content: string) => ({
      tools: [{ name: 'write', args: { path: path(name), content } }],
    })
    const edit = (name: string, oldText: string, newText: string) => ({
      tools: [{ name: 'edit', args: { path: path(name), edits: [{ oldText, newText }] } }],
    })
    // 审批请求之前发出的那份差异。
    const previewOf = (request: any) => {
      const update = c.messages.findLast(
        (m) =>
          m.method === 'item/fileChange/patchUpdated' && m.params.itemId === request.params.itemId,
      )
      assert.ok(update, '审批之前先发了差异')
      assert.ok(c.messages.indexOf(update) < c.messages.indexOf(request))
      return update.params.changes
    }

    // 新文件：差异是正文。允许之后才写下去。
    h.steps.push(write('new.txt', 'NEW\n'))
    const first = await c.start(threadId, '写个新文件')
    const created = await c.approval()
    assert.equal(created.method, 'item/fileChange/requestApproval')
    assert.deepEqual(created.params, {
      threadId,
      turnId: first,
      itemId: created.params.itemId,
      startedAtMs: created.params.startedAtMs,
      reason: null,
      grantRoot: null,
    })
    assert.deepEqual(previewOf(created), [
      { path: path('new.txt'), kind: { type: 'add' }, diff: 'NEW\n' },
    ])
    assert.equal(existsSync(path('new.txt')), false, '答复之前没有写')
    // 后来才看这个会话的连接读到的条目上也有这份差异。
    const pending = (await c.ok('thread/read', { threadId })).thread.turns
      .flatMap((turn: any) => turn.items)
      .find((item: any) => item.id === created.params.itemId)
    assert.deepEqual(pending.changes, previewOf(created))
    await c.decide(created, 'accept')
    assert.equal((await c.completed(first)).status, 'completed')
    assert.equal(readFileSync(path('new.txt'), 'utf8'), 'NEW\n')
    assert.deepEqual(
      [c.item(created.params.itemId).status, c.item(created.params.itemId).changes],
      ['completed', [{ path: path('new.txt'), kind: { type: 'add' }, diff: 'NEW\n' }]],
    )

    // 覆盖现有的文件：差异是补丁。拒绝之后文件没动，模型知道被拒绝了，条目留着这份差异。
    let seen: string[] = []
    h.steps.push(write('new.txt', 'NEWER\n'), (body) => {
      seen = toolResults(body)
      return { text: '不改了' }
    })
    const second = await c.start(threadId, '覆盖它')
    const overwrite = await c.approval()
    const patch = previewOf(overwrite)
    assert.deepEqual(
      [patch.length, patch[0].path, patch[0].kind],
      [1, path('new.txt'), { type: 'update', move_path: null }],
    )
    assert.match(patch[0].diff, /^-NEW$/m)
    assert.match(patch[0].diff, /^\+NEWER$/m)
    await c.decide(overwrite, 'decline')
    await c.completed(second)
    assert.equal(readFileSync(path('new.txt'), 'utf8'), 'NEW\n', '拒绝之后文件没有动')
    assert.equal(seen.at(-1), 'denied by user')
    assert.deepEqual(
      [c.item(overwrite.params.itemId).status, c.item(overwrite.params.itemId).changes],
      ['declined', patch],
    )
    await c.ok('thread/resume', { threadId })
    const reloaded = (await c.ok('thread/read', { threadId })).thread.turns
      .flatMap((turn: any) => turn.items)
      .find((item: any) => item.id === overwrite.params.itemId)
    assert.deepEqual([reloaded.status, reloaded.changes], ['declined', patch], '重新载入之后一样')

    // 改文件：Pi 只给替换片段，补丁是对着文件现在的内容算的。执行之后换成 Pi 给的实际结果。
    await writeFile(path('doc.txt'), 'alpha\nbeta\ngamma\n')
    h.steps.push(edit('doc.txt', 'beta', 'BETA'))
    const third = await c.start(threadId, '改一处')
    const edited = await c.approval()
    assert.equal(edited.params.reason, null)
    const editPatch = previewOf(edited)
    assert.deepEqual(editPatch[0].kind, { type: 'update', move_path: null })
    assert.match(editPatch[0].diff, /^ alpha$/m, '带着上下文，说明是对着整份文件算的')
    assert.match(editPatch[0].diff, /^-beta$/m)
    assert.match(editPatch[0].diff, /^\+BETA$/m)
    assert.equal(readFileSync(path('doc.txt'), 'utf8'), 'alpha\nbeta\ngamma\n')
    await c.decide(edited, 'accept')
    await c.completed(third)
    assert.equal(readFileSync(path('doc.txt'), 'utf8'), 'alpha\nBETA\ngamma\n')
    const applied = c.item(edited.params.itemId)
    assert.equal(applied.status, 'completed')
    assert.match(applied.changes[0].diff, /^-beta$/m)
    assert.match(applied.changes[0].diff, /^\+BETA$/m)

    // 原文在文件里对不上：差异算不出来也照样问，说明原因，给的是替换片段。
    h.steps.push(edit('doc.txt', 'no such line', 'whatever'))
    const fourth = await c.start(threadId, '改一处对不上的')
    const unmatched = await c.approval()
    assert.match(unmatched.params.reason, /没有逐字找到/)
    assert.match(unmatched.params.reason, /只是替换片段/)
    const fragments = previewOf(unmatched)
    assert.match(fragments[0].diff, /^-no such line$/m)
    assert.match(fragments[0].diff, /^\+whatever$/m)
    await c.decide(unmatched, 'accept')
    await c.completed(fourth)
    assert.equal(readFileSync(path('doc.txt'), 'utf8'), 'alpha\nBETA\ngamma\n', 'Pi 自己也没改成')
    assert.equal(c.item(unmatched.params.itemId).status, 'failed')

    // 这个会话里都允许，按文件记：同一个文件再写、再改都不问，别的文件照样问。
    h.steps.push(edit('doc.txt', 'gamma', 'GAMMA'))
    const fifth = await c.start(threadId, '这个文件以后都行')
    await c.decide(await c.approval(), 'acceptForSession')
    await c.completed(fifth)
    const before = c.approvals().length
    h.steps.push(
      write('doc.txt', 'REWRITTEN\n'),
      edit('doc.txt', 'REWRITTEN', 'TWICE'),
      write('other.txt', 'OTHER\n'),
    )
    const sixth = await c.start(threadId, '再动它，再动别的')
    const other = await c.approval()
    assert.deepEqual(previewOf(other)[0].path, path('other.txt'), '放行过的文件没有再问')
    assert.equal(readFileSync(path('doc.txt'), 'utf8'), 'TWICE\n')
    assert.equal(existsSync(path('other.txt')), false)
    await c.decide(other, 'accept')
    await c.completed(sixth)
    assert.equal(readFileSync(path('other.txt'), 'utf8'), 'OTHER\n')
    assert.equal(c.approvals().length, before + 1)
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('APPROVAL-006：拒绝时写的说明交到模型手里；这种决定只列给握手时声明过的连接', {
  timeout: 60000,
}, async () => {
  const h = await approvalHarness()
  try {
    // 设施对每条连接收到的决定列表都核对过：声明了的多一个 declineWithNote，没声明的是标准的。
    const c = await h.connect('litch', ['declineWithNote'])
    const threadId = (await c.ok('thread/start', { cwd: h.cwd, model: MODEL })).thread.id
    let seen: string[] = []
    const capture = (body: any) => {
      seen = toolResults(body)
      return { text: '知道了' }
    }
    h.steps.push({ tools: [{ name: 'bash', args: { command: 'touch prod.txt' } }] }, capture)
    const first = await c.start(threadId, '动生产库')
    const command = await c.approval()
    assert.deepEqual(command.params.availableDecisions, [
      'accept',
      'acceptForSession',
      'decline',
      'declineWithNote',
      'cancel',
    ])
    await c.answer(command, { decision: { declineWithNote: { note: '  先别动生产库  ' } } })
    assert.equal((await c.completed(first)).status, 'completed')
    assert.equal(existsSync(join(h.cwd, 'prod.txt')), false)
    assert.equal(
      seen.at(-1),
      'denied by user. The user left this note explaining why: 先别动生产库',
    )
    assert.equal(c.item(command.params.itemId).status, 'declined')

    h.steps.push(
      { tools: [{ name: 'write', args: { path: join(h.cwd, 'a.txt'), content: 'A' } }] },
      capture,
    )
    const second = await c.start(threadId, '写文件')
    const file = await c.approval()
    assert.equal(file.method, 'item/fileChange/requestApproval')
    assert.equal(file.params.availableDecisions.includes('declineWithNote'), true)
    // 说明是空的，和普通的拒绝一样。
    await c.answer(file, { decision: { declineWithNote: { note: '   ' } } })
    await c.completed(second)
    assert.equal(existsSync(join(h.cwd, 'a.txt')), false)
    assert.equal(seen.at(-1), 'denied by user')
    // 认不出的决定不当成同意。
    h.steps.push({ tools: [{ name: 'bash', args: { command: 'touch odd.txt' } }] }, capture)
    const third = await c.start(threadId, '乱答')
    await c.answer(await c.approval(), { decision: { acceptWithExecpolicyAmendment: {} } })
    await c.completed(third)
    assert.equal(existsSync(join(h.cwd, 'odd.txt')), false)
    assert.equal(seen.at(-1), 'denied by user')
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})
