import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('TURNSETTINGS-001：真实活动回合更新模型与effort，拒绝整批非法设置且不影响其他会话或未来回合', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-turn-settings-'))
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  const releases: Array<() => void> = []
  let requests = 0
  const held = Array.from(
    { length: 2 },
    () => new Promise<void>((resolve) => releases.push(resolve)),
  )
  const verifyModel = (request: ModelRequest, changed = false): void => {
    assert.equal(request.model, changed ? 'claude-opus-5-5' : 'claude-sonnet-4-6')
    assert.equal(request.output_config?.effort, changed ? 'high' : 'low')
  }
  const question = (id: string) => [
    {
      type: 'tool_use',
      id,
      name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: id,
            header: '设置验收',
            multiSelect: false,
            options: [
              { label: '继续', description: '继续本回合' },
              { label: '停止', description: '结束' },
            ],
          },
        ],
      },
    },
  ]
  try {
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/tool/requestUserInput')
      const index = requests++
      assert.ok(index < held.length)
      await held[index]
      return { answers: { [params.questions[0].id]: { answers: ['继续'] } } }
    }
    model.enqueue((request) => {
      verifyModel(request)
      return question('toolu_settings_first')
    })
    model.enqueue((request) => {
      verifyModel(request)
      return question('toolu_settings_second')
    })
    model.enqueue((request) => {
      verifyModel(request)
      return [{ type: 'text', text: 'OTHER_UNCHANGED' }]
    })
    model.enqueue((request) => {
      verifyModel(request, true)
      return [{ type: 'text', text: 'LIVE_SETTINGS_APPLIED' }]
    })
    model.enqueue((request) => {
      verifyModel(request)
      return [{ type: 'text', text: 'FUTURE_UNCHANGED' }]
    })
    const defaults = {
      cwd: home,
      model: 'claude-default',
      config: { model_reasoning_effort: 'low' },
    }
    const { thread } = await client.request('thread/start', defaults)
    const { thread: other } = await client.request('thread/start', defaults)
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '等待回答，再读取更新后的回合设置' }],
    })
    await client.notification('item/tool/requestUserInput')
    const target = { threadId: thread.id, turnId: turn.id }
    assert.deepEqual(
      await client.request('turn/settings/update', { ...target, turnId: 'missing' }),
      { status: 'targetUnavailable' },
    )
    assert.deepEqual(
      await client.request('turn/settings/update', { ...target, threadId: other.id }),
      { status: 'targetUnavailable' },
    )
    for (const invalid of [
      { effort: 'invalid' },
      { model: 'unknown-model' },
      { model: 'opus', effort: 'invalid' },
      { model: 'opus', summary: 3 },
      { model: 'opus', serviceTier: false },
      { model: 'opus', approvalsReviewer: 'invalid' },
      { model: 'opus', unsupported: true },
    ])
      await client.raw('turn/settings/update', { ...target, ...invalid }, -32602)
    // 无效组合必须完全拒绝，下一次真实模型请求仍使用原设置。
    const releaseFirst = releases[0]
    assert.ok(releaseFirst)
    releaseFirst()
    await client.notification(
      'item/tool/requestUserInput',
      (p) => p.questions[0].question === 'toolu_settings_second',
    )
    assert.deepEqual(
      await client.request('turn/settings/update', {
        ...target,
        model: 'opus',
        effort: 'high',
        approvalsReviewer: 'user',
        summary: 'detailed',
        serviceTier: 'fast',
      }),
      { status: 'applied' },
    )
    assert.deepEqual(
      await client.request('turn/settings/update', {
        ...target,
        model: null,
        effort: null,
        summary: null,
        serviceTier: null,
      }),
      { status: 'applied' },
    )
    const otherTurn = await client.request('turn/start', {
      threadId: other.id,
      input: [{ type: 'text', text: '其他会话保持原设置' }],
    })
    assert.equal((await client.completed(otherTurn.turn.id)).status, 'completed')
    const releaseSecond = releases[1]
    assert.ok(releaseSecond)
    releaseSecond()
    assert.equal((await client.completed(turn.id)).status, 'completed')
    assert.deepEqual(await client.request('turn/settings/update', { ...target, effort: 'low' }), {
      status: 'targetUnavailable',
    })
    const resumed = await client.request('thread/resume', { threadId: thread.id })
    assert.equal(resumed.model, defaults.model)
    assert.equal(resumed.reasoningEffort, 'low')
    // 完整适配器重启，验证临时设置没有进入线程或用户配置。
    await client.close()
    client = await ProtocolClient.start(home, url)
    const restarted = await client.request('thread/resume', { threadId: thread.id })
    assert.equal(restarted.model, defaults.model)
    assert.equal(restarted.reasoningEffort, 'low')
    const next = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '未来回合保持原设置' }],
    })
    assert.equal((await client.completed(next.turn.id)).status, 'completed')
    const settings = await readFile(join(home, 'claude', 'settings.json'), 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '{}'
        throw error
      },
    )
    assert.doesNotMatch(settings, /opus|effortLevel/)
    assert.equal(requests, 2)
    assert.equal(model.requests.length, 5)
    model.assertConsumed()
  } finally {
    for (const release of releases) release()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

for (const [reviewer, decision] of [
  ['auto_review', 'accept'],
  ['guardian_subagent', 'decline'],
] as const) {
  test(`TURNSETTINGS-004：${reviewer} 降级为用户审批，模型切换继续且人工${decision}生效`, {
    timeout: 60_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-settings-reviewer-'))
    const model = new MockLLM()
    const client = await ProtocolClient.start(home, await model.start())
    const target = join(home, 'manual-review.txt')
    let releaseQuestion!: () => void
    const questionReady = new Promise<void>((resolve) => {
      releaseQuestion = resolve
    })
    let releaseApproval!: () => void
    const approvalReady = new Promise<void>((resolve) => {
      releaseApproval = resolve
    })
    let approvals = 0
    try {
      client.onServerRequest = async (method, params) => {
        if (method === 'item/tool/requestUserInput') {
          await questionReady
          return { answers: { [params.questions[0].id]: { answers: ['继续'] } } }
        }
        assert.equal(method, 'item/fileChange/requestApproval')
        approvals++
        await approvalReady
        return { decision }
      }
      model.enqueue(() => [
        {
          type: 'tool_use',
          id: 'toolu_before_review_settings',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: '继续验证模型与人工审批',
                header: '审批降级',
                multiSelect: false,
                options: [
                  { label: '继续', description: '继续验收' },
                  { label: '停止', description: '结束回合' },
                ],
              },
            ],
          },
        },
      ])
      model.enqueue((request) => {
        assert.equal(request.model, 'claude-opus-5-5')
        assert.equal(request.output_config?.effort, 'high')
        return [
          {
            type: 'tool_use',
            id: 'toolu_manual_write',
            name: 'Write',
            input: { file_path: target, content: 'MANUALLY_REVIEWED' },
          },
        ]
      })
      model.enqueue((request) => {
        assert.equal(request.model, 'claude-opus-5-5')
        return [{ type: 'text', text: 'MANUAL_REVIEW_DONE' }]
      })
      const { thread } = await client.request('thread/start', {
        cwd: home,
        sandbox: 'danger-full-access',
        approvalPolicy: 'on-request',
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '等待设置更新，再写文件验证用户审批' }],
      })
      await client.notification('item/tool/requestUserInput')
      assert.deepEqual(
        await client.request('turn/settings/update', {
          threadId: thread.id,
          turnId: turn.id,
          model: 'opus',
          effort: 'high',
          approvalsReviewer: reviewer,
        }),
        { status: 'applied' },
      )
      releaseQuestion()
      await client.notification('item/fileChange/requestApproval', (p) => p.turnId === turn.id)
      // 自动审批偏好不得跳过人工回答；拒绝必须保持无文件副作用。
      await assert.rejects(access(target), { code: 'ENOENT' })
      releaseApproval()
      assert.equal((await client.completed(turn.id)).status, 'completed')
      if (decision === 'accept') assert.equal(await readFile(target, 'utf8'), 'MANUALLY_REVIEWED')
      else await assert.rejects(access(target), { code: 'ENOENT' })
      assert.equal(approvals, 1)
      assert.equal(model.requests.length, 3)
      model.assertConsumed()
    } finally {
      releaseQuestion()
      releaseApproval()
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}

test('TURNSETTINGS-002：启动后立即发布设置等待真实CLI就绪，默认可选字段不阻断回合', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-turn-settings-start-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/tool/requestUserInput')
      return { answers: { [params.questions[0].id]: { answers: ['继续'] } } }
    }
    model.enqueue(async () => {
      await held
      return [
        {
          type: 'tool_use',
          id: 'toolu_start_settings',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: '继续验证',
                header: '启动设置',
                multiSelect: false,
                options: [
                  { label: '继续', description: '验证更新' },
                  { label: '停止', description: '停止回合' },
                ],
              },
            ],
          },
        },
      ]
    })
    model.enqueue((request) => {
      assert.equal(request.model, 'claude-opus-5-5')
      assert.equal(request.output_config?.effort, 'high')
      return [{ type: 'text', text: 'STARTUP_SETTINGS_APPLIED' }]
    })
    const { thread } = await client.request('thread/start', { cwd: home })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '立即更新本回合模型' }],
    })
    // 不等待模型、工具或初始化通知，覆盖SDK尚在加载时的发布边界。
    assert.deepEqual(
      await client.request('turn/settings/update', {
        threadId: thread.id,
        turnId: turn.id,
        model: 'opus',
        effort: 'high',
        summary: 'auto',
        serviceTier: null,
      }),
      { status: 'applied' },
    )
    release()
    assert.equal((await client.completed(turn.id)).status, 'completed')
    assert.equal(model.requests.length, 2)
    model.assertConsumed()
  } finally {
    release()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
