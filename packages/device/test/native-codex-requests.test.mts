// 原生 codex 作为聚合面上的又一个 harness（接 native-codex.test.mts）：
// 审批往返、“不支持”和别的错误怎么分、权限预设到审批策略的映射、导入它自己的项目。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Ajv } from 'ajv'
import { codexRig, sentTo } from './codex-kit.mjs'
import { codexThread, FakeCodex } from './fake-codex.mjs'
import { FakeUpstream, fakeProject, RpcFailure } from './fake-upstream.mjs'
import { assertErrorData, errorCode, REPO, rig, settle } from './helpers.mjs'

const THREAD = codexThread(1, 400).id

/** 设备进程替原生 codex 补的决定列表，形状登记在“拒绝时附说明”那份扩展定义里 */
function assertSuppliedDecisions(value: unknown): void {
  const note = JSON.parse(
    readFileSync(join(REPO, 'protocol/extensions/decline-with-note.json'), 'utf8'),
  )
  const part = note.parts.find((item: any) => item.kind === 'SuppliedField')
  const validate = new Ajv({ strict: false }).compile({
    ...part.schema,
    definitions: note.definitions,
  })
  if (!validate(value))
    throw new Error(`补的决定列表和扩展定义对不上：${JSON.stringify(validate.errors)}`)
}

test('命令审批：用原生 codex 自己的决定列表，原样转给客户端，应答原路送回', async () => {
  const env = codexRig()
  try {
    // 声明没声明“拒绝时附说明”，命令审批都是它原样的那一份
    const client = env.connect()
    await client.initialize(['harness', 'declineWithNote'])
    const requestId = env.codex.commandApproval(THREAD)
    const request = await client.waitFor(
      (frame) => frame.method === 'item/commandExecution/requestApproval',
    )
    // 请求号是它那种递增的整数，没撞就不换
    assert.equal(request.id, requestId)
    assert.equal(request.id, 0)
    assert.deepEqual((request.params as any).availableDecisions, [
      'accept',
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo', 'hi'] } },
      'cancel',
    ])
    assert.equal((request.params as any).command, "/bin/zsh -lc 'echo hi > out.txt'")
    // 带参数的决定也原样送回去
    const decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo', 'hi'] } }
    client.answer(request.id, { decision })
    await settle()
    assert.deepEqual(env.codex.live[0]?.answers.at(-1), { id: 0, result: { decision } })
    assert.equal(env.pi.live[0]?.answers.length, 0)
    env.codex.resolved(THREAD, requestId)
    const resolved = await client.waitFor((frame) => frame.method === 'serverRequest/resolved')
    assert.deepEqual(resolved.params, { threadId: THREAD, requestId: 0 })
  } finally {
    await env.close()
  }
})

test('文件改动审批：协议里没有决定列表，只给声明过 declineWithNote 的连接补上固定的四种', async () => {
  const env = codexRig()
  try {
    const declared = env.connect()
    await declared.initialize(['harness', 'declineWithNote'])
    const plain = env.connect()
    await plain.initialize()
    const requestId = env.codex.fileChangeApproval(THREAD)
    const supplemented = await declared.waitFor(
      (frame) => frame.method === 'item/fileChange/requestApproval',
    )
    // 没有 declineWithNote：它收不了说明
    assert.deepEqual((supplemented.params as any).availableDecisions, [
      'accept',
      'acceptForSession',
      'decline',
      'cancel',
    ])
    assertSuppliedDecisions((supplemented.params as any).availableDecisions)
    assert.equal((supplemented.params as any).threadId, THREAD)
    // 没声明的连接上和标准协议逐字段相同
    const untouched = await plain.waitFor(
      (frame) => frame.method === 'item/fileChange/requestApproval',
    )
    assert.deepEqual(untouched.params, {
      threadId: THREAD,
      turnId: `turn-of-${THREAD}`,
      itemId: 'call_2',
      startedAtMs: 2,
      reason: null,
      grantRoot: null,
    })
    declared.answer(supplemented.id, { decision: 'acceptForSession' })
    await settle()
    assert.deepEqual(env.codex.live[0]?.answers.at(-1), {
      id: requestId,
      result: { decision: 'acceptForSession' },
    })

    // 适配器的运行时发的文件改动审批不归设备进程补：它自己按声明给
    env.pi.live[0]?.send({
      id: 'req-pi',
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'p1' },
    })
    const fromPi = await declared.waitFor((frame) => frame.id === 'req-pi')
    assert.deepEqual(fromPi.params, { threadId: 'p1' })
  } finally {
    await env.close()
  }
})

test('不支持：原生 codex 不认识的方法换成聚合面一致的“不支持”，别的错误原样带回', async () => {
  const env = codexRig()
  try {
    const client = env.connect()
    await client.initialize()
    // 按会话走的、按 harness 参数走的，都一样
    for (const [method, params] of [
      ['thread/rollback', { threadId: THREAD, numTurns: 1 }],
      ['future/method', { harness: 'codex' }],
    ] as const) {
      const failure = await client.fails(method, params)
      assert.equal(failure.code, errorCode('unsupported'))
      assert.equal(failure.code, -32601)
      assert.deepEqual(failure.data, { litch: 'unsupported', method, harness: 'codex' })
      assertErrorData(failure.data)
      assert.match(failure.message, new RegExp(`codex 不支持 ${method}`))
    }
    // 设备进程自己替客户端去问它的那种请求（归属以外的会话元数据）也一样
    delete env.codex.handlers['thread/metadata/update']
    const viaQuery = await client.fails('thread/metadata/update', {
      threadId: THREAD,
      gitInfo: { branch: 'main' },
    })
    assert.deepEqual(
      [viaQuery.code, viaQuery.data],
      [-32601, { litch: 'unsupported', method: 'thread/metadata/update', harness: 'codex' }],
    )

    // 参数里的枚举值不认识：原话也是 unknown variant，但点名的不是方法，原样带回
    const badValue = await client.fails('turn/start', {
      threadId: THREAD,
      input: [],
      approvalPolicy: 'sometimes',
    })
    assert.equal(badValue.code, -32600)
    assert.match(badValue.message, /unknown variant `sometimes`/)
    assert.equal(badValue.data, undefined)
    // 缺字段、会话不在、实验性方法没声明：都是它的原话
    const missing = await client.fails('turn/start', { harness: 'codex', input: [] })
    assert.deepEqual(
      [missing.code, missing.message],
      [-32600, 'Invalid request: missing field `threadId`'],
    )
    const stranger = env.connect()
    await stranger.call('initialize', {
      clientInfo: { name: 'plain', title: null, version: '1' },
      capabilities: { litchExtensions: ['harness'] },
    })
    const gated = await stranger.fails('thread/queue/list', { threadId: THREAD })
    assert.deepEqual(
      [gated.code, gated.message, gated.data],
      [-32600, 'thread/queue/list requires experimentalApi capability', undefined],
    )
    // 别的进程正写着这个会话（同一个数据目录上另有一个 codex）：原话带回，不当成不支持
    env.codex.handlers['thread/resume'] = (params) => {
      throw new RpcFailure(-32600, `thread ${params.threadId} already has an active writer`)
    }
    const locked = await client.fails('thread/resume', { threadId: THREAD })
    assert.deepEqual([locked.code, locked.data], [-32600, undefined], '写入锁的错误应该原样带回')
    assert.match(locked.message, /already has an active writer/)

    // 适配器的运行时回的错误不归这条规则管：哪怕原话长得一样也原样带回
    env.pi.handlers['odd/method'] = () => {
      throw new RpcFailure(-32600, 'Invalid request: unknown variant `odd/method`, expected x')
    }
    const fromPi = await client.fails('odd/method', { harness: 'pi' })
    assert.deepEqual([fromPi.code, fromPi.data], [-32600, undefined])
  } finally {
    await env.close()
  }
})

test('权限预设：选了内置档又没带审批策略的，转给原生 codex 时配上这一档的审批策略', async () => {
  const env = codexRig()
  try {
    const client = env.connect()
    await client.initialize()
    await client.call('thread/start', { harness: 'codex', permissions: ':danger-full-access' })
    assert.deepEqual(sentTo(env.codex, 'thread/start').at(-1), {
      permissions: ':danger-full-access',
      approvalPolicy: 'never',
    })
    await client.call('turn/start', { threadId: THREAD, input: [], permissions: ':workspace' })
    assert.deepEqual(sentTo(env.codex, 'turn/start').at(-1), {
      threadId: THREAD,
      input: [],
      permissions: ':workspace',
      approvalPolicy: 'on-request',
    })
    await client.call('thread/settings/update', { threadId: THREAD, permissions: ':read-only' })
    assert.deepEqual(sentTo(env.codex, 'thread/settings/update').at(-1), {
      threadId: THREAD,
      permissions: ':read-only',
      approvalPolicy: 'on-request',
    })
    await client.call('thread/resume', { threadId: THREAD, permissions: ':workspace' })
    assert.equal(sentTo(env.codex, 'thread/resume').at(-1).approvalPolicy, 'on-request')
    await client.call('thread/fork', { threadId: THREAD, permissions: ':danger-full-access' })
    assert.equal(sentTo(env.codex, 'thread/fork').at(-1).approvalPolicy, 'never')

    // 客户端自己带了审批策略的不动；用户自己定义的权限档不动；没选档的不动
    const raw = env.codex.live[0]?.raw.length ?? 0
    await client.call('turn/start', {
      threadId: THREAD,
      input: [],
      permissions: ':workspace',
      approvalPolicy: 'untrusted',
    })
    await client.call('turn/start', { threadId: THREAD, input: [], permissions: 'my-profile' })
    await client.call('turn/start', { threadId: THREAD, input: [] })
    assert.deepEqual(
      sentTo(env.codex, 'turn/start')
        .slice(-3)
        .map((params) => params.approvalPolicy),
      ['untrusted', undefined, undefined],
    )
    // 不用改的请求是原文转过去的，没有重新序列化
    assert.match(
      env.codex.live[0]?.raw[raw] ?? '',
      /"permissions":":workspace","approvalPolicy":"untrusted"/,
    )
    // 给适配器的运行时的不加：映射在它们自己那里
    await client.call('turn/start', { threadId: 'p1', input: [], permissions: ':workspace' })
    assert.equal(sentTo(env.pi, 'turn/start').at(-1).approvalPolicy, undefined)
  } finally {
    await env.close()
  }
})

test('导入：第一次启用工作区时也读原生 codex 自己的项目；它没有这组方法就跳过，不算失败', async () => {
  const mine = codexThread(1, 400, { projectId: 'cx-app' })
  const loose = codexThread(2, 200)
  const withProjects = new FakeCodex(
    [mine, loose],
    [fakeProject('cx-app', 'Codex 的应用', ['/work/app'], { createdAt: 500 })],
  )
  // 旧一些的 codex：没有项目和分区这两组方法，回的是“不认识的方法”
  const without = new FakeCodex([codexThread(1, 400), codexThread(2, 200)])
  delete without.handlers['project/list']
  delete without.handlers['threadSection/list']
  for (const fake of [withProjects, without]) {
    const env = codexRig({ fake, device: { importExisting: true } })
    try {
      const client = env.connect()
      await client.initialize(['harness', 'deviceWorkspaces'])
      const projects = (await client.call('project/list', {})).data
      const list = await client.call('thread/list', { limit: 10, harness: 'codex' })
      assert.deepEqual(list.skippedHarnesses, [])
      if (fake === withProjects) {
        assert.deepEqual(
          projects.map((project: any) => [project.name, project.roots]),
          [['Codex 的应用', [{ path: '/work/app' }]]],
        )
        // 归属带过来了，换成了设备层的工作区标识
        assert.deepEqual(
          list.data.map((thread: any) => thread.projectId),
          [projects[0].id, null],
        )
      } else {
        assert.deepEqual(projects, [])
        assert.equal(list.data.length, 2)
        assert.ok(
          env.logs.some((line) => line.includes('导入 codex') && line.includes('当作没有')),
          env.logs.join('\n'),
        )
      }
      // 导入只读不写，也不带我们的扩展键
      const side = fake.greetings.find((greeting) => greeting.clientInfo.name === 'litch-device')
      assert.equal(side.capabilities.litchExtensions, undefined)
      assert.ok(!fake.seen.some((entry) => /^project\/(create|update|delete)/.test(entry.method)))
      assert.ok(
        env.logs.some((line) => /从 .*codex.* 导入了现有的项目/.test(line)),
        env.logs.join('\n'),
      )
    } finally {
      await env.close()
    }
  }
})

test('没标明是原生的 codex 上游（单独起设备进程时手工配的）照旧：不替它整理声明，不改它的错误', async () => {
  const pi = new FakeUpstream('pi')
  const codex = new FakeCodex([codexThread(1, 400)])
  const env = rig({ pi, codex })
  try {
    const client = env.connect()
    await client.initialize()
    const info = await client.call('runtime/info')
    const described = info.harnesses.find((item: any) => item.id === 'codex')
    assert.deepEqual(
      [described.engine, described.version, described.features],
      [null, '0.160.0', undefined],
    )
    const failure = await client.fails('future/method', { harness: 'codex' })
    assert.equal(failure.code, -32600)
  } finally {
    await env.close()
  }
})
