// 真 CLI 的隔离 TUI 验收：指定 CHA_CLAUDE_CLI >=2.1.316，只连回环 MockLLM。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from '../../packages/claude/dist/claude/test/fixtures/mock-llm.mjs'
import { ProtocolClient } from '../../packages/claude/dist/claude/test/fixtures/protocol-client.mjs'

test('TUI：SDK → TUI → SDK 保持上下文、标题和历史；TUI 工具审批与拒绝', {
  timeout: 180_000,
}, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ltt-')))
  const config = join(home, 'claude')
  await mkdir(config)
  // 2.1.316 忽略项目登录凭据，但仍应读取普通项目环境；两个后端切换后规则一致。
  await mkdir(join(home, '.claude'))
  await writeFile(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-project-must-be-ignored',
        CHA_TUI_PROJECT_PROBE: 'project-loaded',
      },
    }),
  )
  const onboarding = {
    hasCompletedOnboarding: true,
    theme: 'dark',
    projects: { [home]: { hasTrustDialogAccepted: true } },
    customApiKeyResponses: { approved: ['test-not-a-secret'], rejected: [] },
  }
  await writeFile(join(config, '.claude.json'), JSON.stringify(onboarding))
  await writeFile(join(home, '.claude.json'), JSON.stringify(onboarding))
  const settings = join(home, 'device-settings.json')
  const mode = async (backend) =>
    writeFile(
      settings,
      JSON.stringify({ version: 1, values: { 'harness.claude-code.backend': backend } }),
    )
  await mode('sdk')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start(), false, 'api-key', {
    CHA_CLAUDE_BACKEND_SETTINGS: settings,
    CHA_CLAUDE_CROSS_SESSION_INBOX: 'off',
    CHA_CLAUDE_SESSION_TITLE: 'off',
    CHA_CLAUDE_PLANS_LOCATION: 'config',
  })
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      model: 'claude-sonnet-4-6',
      approvalPolicy: 'untrusted',
      sandbox: 'danger-full-access',
    })
    await client.request('thread/name/set', { threadId: thread.id, name: '后端切换验收' })
    for (const [index, backend] of ['sdk', 'tui', 'sdk'].entries()) {
      await mode(backend)
      let arrived
      let release
      const requested = new Promise((resolve) => {
        arrived = resolve
      })
      const released = new Promise((resolve) => {
        release = resolve
      })
      model.enqueue(async (body, headers) => {
        assert.equal(headers['x-api-key'], 'test-not-a-secret')
        assert.ok(!String(headers.authorization).includes('project-must-be-ignored'))
        if (index) assert.match(JSON.stringify(body.messages), /CONTEXT_SEED_0/)
        if (backend === 'tui') {
          console.log('TUI UA', headers['user-agent'])
          assert.match(headers['user-agent'], /\(external, cli\)/)
          assert.match(JSON.stringify(body.system), /cc_entrypoint=cli/)
        }
        arrived()
        await released
        return [{ type: 'text', text: `BACKEND_REPLY_${index}` }]
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: `CONTEXT_SEED_${index}` }],
      })
      await requested
      await mode(backend === 'sdk' ? 'tui' : 'sdk')
      release()
      const completed = await client.completed(turn.id)
      assert.equal(completed.status, 'completed', JSON.stringify(completed) + client.stderr)
      model.assertConsumed()
    }
    const history = (
      await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    ).thread
    assert.equal(history.name, '后端切换验收')
    assert.equal(history.turns.length, 3)
    for (let index = 0; index < 3; index++) {
      const texts = history.turns[index].items
        .filter((item) => item.type === 'agentMessage')
        .map((item) => item.text)
        .join('')
      assert.equal(texts, `BACKEND_REPLY_${index}`)
    }
    await mode('sdk')
    const { thread: fork } = await client.request('thread/fork', { threadId: thread.id })
    await mode('tui')
    const modes = await client.request('collaborationMode/list', {})
    assert.deepEqual(
      modes.data.map((entry) => entry.mode),
      ['default'],
    )
    const { thread: planning } = await client.request('thread/start', { cwd: home })
    const { turn: planned } = await client.request('turn/start', {
      threadId: planning.id,
      input: [{ type: 'text', text: 'PLAN_MUST_NOT_REACH_MODEL' }],
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'claude-sonnet-4-6',
          developer_instructions: null,
          reasoning_effort: null,
        },
      },
    })
    const planRefused = await client.completed(planned.id)
    assert.equal(planRefused.status, 'failed')
    assert.match(planRefused.error.message, /TUI.*计划模式/)
    model.enqueue((body) => {
      assert.match(JSON.stringify(body.messages), /CONTEXT_SEED_0/)
      return [{ type: 'text', text: 'FORK_RESUMED_IN_TUI' }]
    })
    const { turn: forkTurn } = await client.request('turn/start', {
      threadId: fork.id,
      input: [{ type: 'text', text: 'FORK_RESUME' }],
    })
    assert.equal((await client.completed(forkTurn.id)).status, 'completed')
    model.assertConsumed()
    for (const approve of [true, false]) {
      const file = join(home, approve ? 'approved.txt' : 'denied.txt')
      let approvals = 0
      client.onServerRequest = async (method) => {
        assert.match(method, /requestApproval/)
        approvals++
        return { decision: approve ? 'accept' : 'decline' }
      }
      model.enqueue(() => [
        {
          type: 'tool_use',
          id: `tool_${approve}`,
          name: 'Bash',
          input: {
            command: `test "$CHA_TUI_PROJECT_PROBE" = project-loaded && printf approved > '${file}'`,
          },
        },
      ])
      model.enqueue(() => [{ type: 'text', text: 'TOOL_DONE' }])
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: `TOOL_${approve}` }],
      })
      const completed = await client.completed(turn.id)
      assert.equal(completed.status, 'completed', JSON.stringify(completed) + client.stderr)
      assert.equal(approvals, 1)
      if (approve) assert.equal(await readFile(file, 'utf8'), 'approved')
      else await assert.rejects(readFile(file), { code: 'ENOENT' })
      model.assertConsumed()
    }
    let questions = 0
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/tool/requestUserInput')
      questions++
      return { answers: { [params.questions[0].id]: { answers: ['Blue'] } } }
    }
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'tui_question',
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which color?',
              header: 'Color',
              multiSelect: false,
              options: [
                { label: 'Blue', description: 'Blue option' },
                { label: 'Red', description: 'Red option' },
              ],
            },
          ],
        },
      },
    ])
    model.enqueue((body) => {
      assert.match(JSON.stringify(body.messages.at(-1)), /Blue/)
      return [{ type: 'text', text: 'ANSWER_BLUE' }]
    })
    const { turn: questionTurn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'QUESTION_CHECK' }],
    })
    assert.equal((await client.completed(questionTurn.id)).status, 'completed')
    assert.equal(questions, 1)
    model.assertConsumed()
    const { dynamicToolName } = await import(
      '../../packages/claude/dist/claude/src/dynamic-tools.mjs'
    )
    const { thread: toolThread } = await client.request('thread/start', {
      cwd: home,
      dynamicTools: [
        {
          type: 'function',
          name: 'echo',
          description: 'Echo test',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
        },
      ],
    })
    let calls = 0
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/tool/call')
      calls++
      return {
        success: true,
        contentItems: [{ type: 'inputText', text: `TUI_ECHO ${params.arguments.text}` }],
      }
    }
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'tui_echo',
        name: `mcp__codex_harness_adapter__${dynamicToolName(null, 'echo')}`,
        input: { text: 'value' },
      },
    ])
    model.enqueue((body) => {
      assert.match(JSON.stringify(body.messages.at(-1)), /TUI_ECHO value/)
      return [{ type: 'text', text: 'MCP_DONE' }]
    })
    const { turn: toolTurn } = await client.request('turn/start', {
      threadId: toolThread.id,
      input: [{ type: 'text', text: 'MCP_CHECK' }],
    })
    assert.equal((await client.completed(toolTurn.id)).status, 'completed')
    assert.equal(calls, 1)
    model.assertConsumed()
    model.enqueue(() => [
      { type: 'text', text: 'STREAM_ONE\n', pauseAfterMs: 2500 },
      { type: 'text', text: 'STREAM_TWO' },
    ])
    const { turn: streaming } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'STREAM_CHECK' }],
    })
    await client.notification(
      'item/agentMessage/delta',
      (event) => event.turnId === streaming.id && event.delta.includes('STREAM_ONE'),
    )
    assert.ok(
      !client.trace.some(
        (event) => event.method === 'turn/completed' && event.params.turn.id === streaming.id,
      ),
      '流式首块必须早于回合完成',
    )
    assert.equal((await client.completed(streaming.id)).status, 'completed')
    model.assertConsumed()
    const { thread: fresh } = await client.request('thread/start', {
      cwd: home,
      model: 'claude-sonnet-4-6',
    })
    let started
    const modelStarted = new Promise((resolve) => {
      started = resolve
    })
    model.enqueue(() => {
      started()
      return [
        { type: 'text', text: 'INTERRUPT_PARTIAL\n', pauseAfterMs: 3000 },
        { type: 'text', text: 'INTERRUPT_END' },
      ]
    })
    const { turn: interrupted } = await client.request('turn/start', {
      threadId: fresh.id,
      input: [{ type: 'text', text: 'INTERRUPT_INPUT' }],
    })
    await modelStarted
    await client.request('turn/interrupt', { threadId: fresh.id, turnId: interrupted.id })
    assert.equal((await client.completed(interrupted.id)).status, 'interrupted')
    model.enqueue((body) => {
      assert.match(JSON.stringify(body.messages), /INTERRUPT_INPUT/)
      return [{ type: 'text', text: 'AFTER_INTERRUPT' }]
    })
    const { turn: resumed } = await client.request('turn/start', {
      threadId: fresh.id,
      input: [{ type: 'text', text: 'RESUME_CHECK' }],
    })
    assert.equal((await client.completed(resumed.id)).status, 'completed')
  } finally {
    await writeFile(join(home, 'requests.json'), JSON.stringify(model.requests, null, 2))
    await writeFile(join(home, 'trace.json'), JSON.stringify(client.trace, null, 2))
    await writeFile(join(home, 'stderr.log'), client.stderr)
    console.log(`TUI 验收材料：${home}`)
    await client.close()
    await model.close()
  }
})

test('切到 TUI 时拒绝接管仍在运行的 SDK 后台命令，并保留原进程', { timeout: 60_000 }, async () => {
  const { startScene, disposeScene, backgroundBash, say, runTurn, uniqueSleep, commandAlive } =
    await import('../../packages/claude/dist/claude/test/fixtures/background-scene.mjs')
  const path = join(await mkdtemp(join(tmpdir(), 'ltt-switch-')), 'settings.json')
  await writeFile(path, JSON.stringify({ values: { 'harness.claude-code.backend': 'sdk' } }))
  const scene = await startScene('tui-switch-background', {
    CHA_CLAUDE_BACKEND_SETTINGS: path,
    CHA_CLAUDE_SESSION_TITLE: 'off',
  })
  const command = uniqueSleep(45)
  try {
    scene.model.enqueue(backgroundBash('background_before_switch', command))
    scene.model.enqueue(say('BACKGROUND_STARTED'))
    assert.equal((await runTurn(scene, '启动后台工作')).status, 'completed')
    assert.equal(commandAlive(command), true)
    const calls = scene.model.requests.length
    await writeFile(path, JSON.stringify({ values: { 'harness.claude-code.backend': 'tui' } }))
    const refused = await runTurn(scene, '切到 TUI')
    assert.equal(refused.status, 'failed')
    assert.match(refused.error.message, /后台任务/)
    assert.equal(scene.model.requests.length, calls)
    assert.equal(commandAlive(command), true, '拒绝切换不能杀死旧后端的任务')
  } finally {
    await disposeScene(scene)
  }
})
