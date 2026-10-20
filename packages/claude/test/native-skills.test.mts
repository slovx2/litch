import assert from 'node:assert/strict'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

function toolResult(request: ModelRequest, id: string): any {
  const results = request.messages
    .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
    .filter((item: any) => item.type === 'tool_result' && item.tool_use_id === id)
  assert.equal(results.length, 1, '真实 Skill 必须返回唯一结果')
  return results[0]
}

async function writeSkill(root: string, name: string, target: string): Promise<string> {
  const path = join(root, name, 'SKILL.md')
  await mkdir(join(root, name), { recursive: true })
  await writeFile(
    path,
    [
      '---',
      'name: ' + name,
      'description: NATIVE_SKILL_DESCRIPTION_' + name,
      'allowed-tools: Bash',
      '---',
      'NATIVE_SKILL_BODY_' + name,
      '!`echo NATIVE_SKILL_EXECUTED >> ' +
        JSON.stringify(target) +
        '; printf INLINE_EFFECT_CONFIRMED`',
      'Return the inline result without running any other tool.',
      '',
    ].join('\n'),
  )
  return path
}

async function invokeSkill(
  client: ProtocolClient,
  model: MockLLM,
  threadId: string,
  name: string,
  enabled: boolean,
  id: string,
): Promise<void> {
  model.enqueue(() => [{ type: 'tool_use', id, name: 'Skill', input: { skill: name } }])
  model.enqueue((request) => {
    const result = toolResult(request, id)
    assert.equal(result.is_error === true, !enabled, 'Skill 工具结果状态与开关不一致')
    if (enabled) assert.match(JSON.stringify(request.messages), /INLINE_EFFECT_CONFIRMED/)
    return [{ type: 'text', text: enabled ? 'SKILL_EXECUTED' : 'SKILL_DISABLED' }]
  })
  const { turn } = await client.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Invoke the requested fixture skill once.' }],
  })
  const completed = await client.completed(turn.id)
  assert.equal(
    completed.status,
    'completed',
    JSON.stringify({ error: completed.error, unexpected: model.unexpected }),
  )
}

test('SKILLS-001：原生 Skill 禁用不执行内联命令，启用及重启状态真实持久化', {
  timeout: 90_000,
}, async () => {
  const home = await realpath(await mkdtemp('/tmp/native-skills-state-'))
  const cwd = join(home, 'project')
  const effect = join(cwd, 'skill-effect.txt')
  const path = await writeSkill(join(cwd, '.claude', 'skills'), 'fixture', effect)
  await writeFile(
    join(cwd, '.claude', 'settings.json'),
    JSON.stringify({
      skillOverrides: { fixture: 'off' },
    }),
  )
  const model = new MockLLM()
  const endpoint = await model.start()
  let client = await ProtocolClient.start(home, endpoint)
  const list = async () =>
    (await client.request('skills/list', { cwds: [cwd], forceReload: true })).data[0]
  try {
    const before = await list()
    assert.deepEqual(before.errors, [])
    assert.equal(before.skills.find((skill: any) => skill.name === 'fixture').path, path)
    assert.equal(model.requests.length, 0, '技能管理不能调用模型')
    const { thread } = await client.request('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    assert.equal(before.skills.find((skill: any) => skill.name === 'fixture').enabled, false)
    await invokeSkill(client, model, thread.id, 'fixture', false, 'toolu_native_disabled')
    await assert.rejects(access(effect), '未覆盖时保留原生 settings.json 的禁用状态')
    await client.request('skills/config/write', { name: 'fixture', enabled: true })
    await invokeSkill(client, model, thread.id, 'fixture', true, 'toolu_enabled')
    assert.equal(await readFile(effect, 'utf8'), 'NATIVE_SKILL_EXECUTED\n')
    assert.equal(
      (await client.request('skills/config/write', { path, enabled: false })).effectiveEnabled,
      false,
    )
    assert.equal(
      (await list()).skills.find((skill: any) => skill.name === 'fixture').enabled,
      false,
    )
    await client.close()
    client = await ProtocolClient.start(home, endpoint)
    assert.equal(
      (await list()).skills.find((skill: any) => skill.name === 'fixture').enabled,
      false,
    )
    await client.request('thread/resume', { threadId: thread.id })
    await invokeSkill(client, model, thread.id, 'fixture', false, 'toolu_disabled')
    assert.equal(
      await readFile(effect, 'utf8'),
      'NATIVE_SKILL_EXECUTED\n',
      '禁用后内联命令不得再次执行',
    )
    assert.equal(
      (await client.request('skills/config/write', { path, enabled: true })).effectiveEnabled,
      true,
    )
    await invokeSkill(client, model, thread.id, 'fixture', true, 'toolu_reenabled')
    assert.equal(await readFile(effect, 'utf8'), 'NATIVE_SKILL_EXECUTED\nNATIVE_SKILL_EXECUTED\n')
    const state = join(home, 'adapter', 'config.json')
    assert.equal((await stat(state)).mode & 0o777, 0o600)
    await rename(state, state + '.backup')
    await mkdir(state)
    try {
      await client.raw('skills/config/write', { path, enabled: false }, -32000)
      assert.equal(
        (await list()).skills.find((skill: any) => skill.name === 'fixture').enabled,
        true,
      )
      await invokeSkill(client, model, thread.id, 'fixture', true, 'toolu_after_failed_write')
      assert.equal(
        (await readFile(effect, 'utf8')).trim().split('\n').length,
        3,
        '配置落盘失败不能改变真实 CLI 的有效开关',
      )
    } finally {
      await rm(state, { recursive: true })
      await rename(state + '.backup', state)
    }
    assert.equal(model.requests.length, 10)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SKILLS-002：额外技能目录由真实 CLI 加载，移除和重启不保留技能入口', {
  timeout: 90_000,
}, async () => {
  const home = await realpath(await mkdtemp('/tmp/native-skills-roots-'))
  const cwd = join(home, 'project')
  await mkdir(cwd)
  const root = join(home, 'extra')
  const effect = join(cwd, 'extra-effect.txt')
  const path = await writeSkill(root, 'extra-fixture', effect)
  await writeFile(path, (await readFile(path, 'utf8')).replace('name: extra-fixture\n', ''))
  const model = new MockLLM()
  const endpoint = await model.start()
  let client = await ProtocolClient.start(home, endpoint)
  const skills = async () =>
    (await client.request('skills/list', { cwds: [cwd], forceReload: true })).data[0].skills
  try {
    assert.equal(
      (await skills()).some((skill: any) => skill.path === path),
      false,
    )
    await client.request('skills/extraRoots/set', { extraRoots: [root] })
    assert.equal((await skills()).find((skill: any) => skill.path === path).enabled, true)
    assert.equal(model.requests.length, 0)
    const { thread } = await client.request('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    await invokeSkill(client, model, thread.id, 'extra-fixture', true, 'toolu_extra')
    assert.equal(await readFile(effect, 'utf8'), 'NATIVE_SKILL_EXECUTED\n')
    await client.request('skills/extraRoots/set', { extraRoots: [] })
    assert.equal(
      (await skills()).some((skill: any) => skill.path === path),
      false,
    )
    await invokeSkill(client, model, thread.id, 'extra-fixture', false, 'toolu_removed')
    assert.equal(await readFile(effect, 'utf8'), 'NATIVE_SKILL_EXECUTED\n')
    await client.request('skills/extraRoots/set', { extraRoots: [root] })
    client.crash()
    await client.close()
    client = await ProtocolClient.start(home, endpoint)
    assert.equal(
      (await skills()).some((skill: any) => skill.path === path),
      false,
    )
    const next = await client.request('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    await invokeSkill(client, model, next.thread.id, 'extra-fixture', false, 'toolu_after_restart')
    assert.equal(await readFile(effect, 'utf8'), 'NATIVE_SKILL_EXECUTED\n')
    await access(path)
    assert.equal(model.requests.length, 6)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SKILLS-003：原生 Skill 内联命令不能绕过会话目录沙箱', {
  timeout: 60_000,
}, async () => {
  const home = await realpath(await mkdtemp('/tmp/native-skills-permissions-'))
  const cwd = join(home, 'project')
  const effect = join(home, 'outside-effect.txt')
  const path = await writeSkill(join(cwd, '.claude', 'skills'), 'boundary-fixture', effect)
  const model = new MockLLM()
  const endpoint = await model.start()
  const client = await ProtocolClient.start(home, endpoint)
  try {
    let approvals = 0
    client.onServerRequest = async (method) => {
      assert.equal(method, 'item/fileChange/requestApproval')
      approvals++
      await client.raw('skills/config/write', { path, enabled: false }, -32009)
      await client.raw('skills/extraRoots/set', { extraRoots: [] }, -32009)
      return { decision: 'accept' }
    }
    const { thread } = await client.request('thread/start', {
      cwd,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    })
    await client.request('thread/settings/update', {
      threadId: thread.id,
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    })
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'toolu_boundary',
        name: 'Skill',
        input: { skill: 'boundary-fixture' },
      },
    ])
    model.enqueue((request) => {
      assert.notEqual(
        toolResult(request, 'toolu_boundary').is_error,
        true,
        '受限会话仍应加载 Skill 正文',
      )
      return [{ type: 'text', text: 'BOUNDARY_CHECKED' }]
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'Invoke boundary-fixture once.' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    assert.equal(approvals, 1, '真实 Skill 权限已通过客户端审批')
    await assert.rejects(access(effect), '技能内联命令不能写入沙箱以外目录')
    for (const scenario of ['read-only', 'plan', 'full-access-with-approval']) {
      const started = await client.request('thread/start', {
        cwd,
        approvalPolicy: 'on-request',
        sandbox: scenario === 'read-only' ? 'read-only' : 'danger-full-access',
      })
      if (scenario === 'plan')
        await client.request('thread/settings/update', {
          threadId: started.thread.id,
          collaborationMode: {
            mode: 'plan',
            settings: {
              model: started.model,
              reasoning_effort: started.reasoningEffort,
              developer_instructions: null,
            },
          },
        })
      // 显式 /skill 在首个模型请求前展开，也必须遵守同一个内联执行限制。
      model.enqueue(() => [{ type: 'text', text: 'SLASH_SKILL_CHECKED' }])
      const next = await client.request('turn/start', {
        threadId: started.thread.id,
        input: [{ type: 'text', text: '/boundary-fixture' }],
      })
      assert.equal((await client.completed(next.turn.id)).status, 'completed')
      await assert.rejects(access(effect), scenario + ' 不能通过显式技能调用跳过命令审批')
    }
    assert.equal(approvals, 1, '技能元数据不能生成不可见的自动命令审批')
    assert.equal(model.requests.length, 5)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SKILLS-005：子目录会话中原生继承的项目 Skill 可列出并禁用', {
  timeout: 60_000,
}, async () => {
  const home = await realpath(await mkdtemp('/tmp/native-skills-ancestor-'))
  const project = join(home, 'project')
  const cwd = join(project, 'nested')
  await mkdir(cwd, { recursive: true })
  const effect = join(cwd, 'ancestor-effect.txt')
  const path = await writeSkill(join(project, '.claude', 'skills'), 'ancestor-fixture', effect)
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    await invokeSkill(client, model, thread.id, 'ancestor-fixture', true, 'toolu_ancestor')
    assert.equal(await readFile(effect, 'utf8'), 'NATIVE_SKILL_EXECUTED\n')
    const list = await client.request('skills/list', {})
    assert.equal(
      list.data[0].skills.find((skill: any) => skill.path === path)?.enabled,
      true,
      '当前目录已能原生执行的祖先技能必须出现在目录中',
    )
    await client.request('skills/config/write', { path, enabled: false })
    await invokeSkill(
      client,
      model,
      thread.id,
      'ancestor-fixture',
      false,
      'toolu_ancestor_disabled',
    )
    assert.equal(await readFile(effect, 'utf8'), 'NATIVE_SKILL_EXECUTED\n')
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SKILLS-006：输入里选的技能带着正文、带着图片发出去，正文都交给模型', {
  timeout: 90_000,
}, async () => {
  const home = await realpath(await mkdtemp('/tmp/native-skills-input-'))
  const cwd = join(home, 'project')
  const path = join(cwd, '.claude', 'skills', 'input-fixture', 'SKILL.md')
  await mkdir(join(cwd, '.claude', 'skills', 'input-fixture'), { recursive: true })
  await writeFile(
    path,
    '---\nname: input-fixture\ndescription: INPUT_SKILL_DESCRIPTION\n---\nINPUT_SKILL_BODY\n',
  )
  const image = join(cwd, 'dot.png')
  await writeFile(
    image,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    ),
  )
  const skill = { type: 'skill', name: 'input-fixture', path }
  const text = (value: string) => ({ type: 'text', text: value, text_elements: [] })
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  // 每种输入各开一个会话，交给模型的消息里只有这一句话；返回这一回合模型收到的消息
  const send = async (input: unknown[]): Promise<string> => {
    const { thread } = await client.request('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    const before = model.requests.length
    model.enqueue(() => [{ type: 'text', text: 'INPUT_SKILL_OK' }])
    const { turn } = await client.request('turn/start', { threadId: thread.id, input })
    const completed = await client.completed(turn.id)
    assert.equal(
      completed.status,
      'completed',
      JSON.stringify({ error: completed.error, unexpected: model.unexpected }),
    )
    assert.equal(model.requests.length, before + 1)
    model.assertConsumed()
    return JSON.stringify(model.requests.at(-1)?.messages)
  }
  try {
    // 选了的技能，正文在交给模型的消息里（技能清单里只有描述）。不用 assert.match：失败时不把整个请求打出来
    const expanded = (messages: string) => messages.includes('INPUT_SKILL_BODY')
    const withText = await send([skill, text('看一下 这次改动')])
    assert.ok(expanded(withText), '带正文时技能没有展开')
    assert.ok(withText.includes('看一下 这次改动'))
    assert.ok(expanded(await send([skill])), '只有技能时没有展开')
    // 带图片时发的是内容块
    const withImage = await send([
      skill,
      text('看一下 这张图'),
      { type: 'localImage', path: image },
    ])
    assert.ok(expanded(withImage), '带图片时技能没有展开')
    assert.ok(withImage.includes('看一下 这张图'))
    assert.ok(withImage.includes('"type":"image"'))
    assert.ok(
      expanded(await send([skill, { type: 'localImage', path: image }])),
      '只有技能和图片时没有展开',
    )
    // 没选技能的不受影响
    assert.ok(!expanded(await send([text('看一下 这次改动')])))
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SKILLS-007：选的技能不论排在哪、来自额外目录还是插话，正文都按上游的 <skill> 片段交给模型；关掉的不给，清单外的照旧', {
  timeout: 90_000,
}, async () => {
  const home = await realpath(await mkdtemp('/tmp/native-skills-inject-'))
  const cwd = join(home, 'project')
  await mkdir(cwd)
  const root = join(home, 'extra')
  const path = join(root, 'extra-input', 'SKILL.md')
  await mkdir(join(root, 'extra-input'), { recursive: true })
  await writeFile(
    path,
    '---\nname: extra-input\ndescription: EXTRA_INPUT_DESCRIPTION\n---\nEXTRA_INPUT_BODY\n',
  )
  const skill = { type: 'skill', name: 'extra-input', path }
  const text = (value: string) => ({ type: 'text', text: value, text_elements: [] })
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  const newThread = async (): Promise<string> =>
    (
      await client.request('thread/start', {
        cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      })
    ).thread.id
  const send = async (input: unknown[]): Promise<string> => {
    const threadId = await newThread()
    model.enqueue(() => [{ type: 'text', text: 'INJECT_OK' }])
    const { turn } = await client.request('turn/start', { threadId, input })
    const completed = await client.completed(turn.id)
    assert.equal(completed.status, 'completed', JSON.stringify(completed.error))
    model.assertConsumed()
    const read = await client.request('thread/read', { threadId, includeTurns: true })
    assert.deepEqual(read.thread.turns[0].items[0].content, input, '记录里是用户原样的输入')
    return JSON.stringify(model.requests.at(-1)?.messages)
  }
  try {
    await client.request('skills/extraRoots/set', { extraRoots: [root] })
    // 技能排在话后面（WakeQora、Litch 的输入框都这么发）：CLI 不认，以前正文到不了模型
    const after = await send([text('按 Skill 执行'), skill])
    assert.ok(after.includes('EXTRA_INPUT_BODY'), '技能在后面时正文没交给模型')
    assert.ok(after.includes(`<skill>\\n<name>extra-input</name>\\n<path>${path}</path>`))
    assert.ok(after.includes('按 Skill 执行'))
    // 路径里本身有 /extra-input，认的是以前那样跟在话后面的一行
    assert.ok(!after.includes('执行\\n/extra-input'), '不再拼“/名字”')
    // 清单外的技能（比如 CLI 插件带的）照旧转成“/名字”交给 CLI
    const unknown = await send([
      text('按 Skill 执行'),
      { type: 'skill', name: 'not-in-catalog', path: join(home, 'missing', 'SKILL.md') },
    ])
    assert.ok(unknown.includes('/not-in-catalog'))
    // 插话里选的技能也交给模型
    const threadId = await newThread()
    let arrived!: () => void
    const firstArrived = new Promise<void>((resolve) => {
      arrived = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    model.enqueue(async () => {
      arrived()
      await gate
      return [{ type: 'text', text: 'FIRST' }]
    })
    model.enqueue((request) => {
      const messages = JSON.stringify(request.messages)
      assert.ok(messages.includes('EXTRA_INPUT_BODY'), '插话里的技能正文没交给模型')
      assert.ok(messages.includes('STEER_WITH_SKILL'))
      return [{ type: 'text', text: 'SECOND' }]
    })
    const { turn } = await client.request('turn/start', {
      threadId,
      input: [text('FIRST_INPUT')],
    })
    await firstArrived
    await client.request('turn/steer', {
      threadId,
      expectedTurnId: turn.id,
      input: [text('STEER_WITH_SKILL'), skill],
    })
    release()
    assert.equal((await client.completed(turn.id)).status, 'completed')
    model.assertConsumed()
    // 关掉的技能和上游一样什么都不给
    await client.request('skills/config/write', { path, enabled: false })
    const disabled = await send([text('按 Skill 执行'), skill])
    assert.ok(!disabled.includes('EXTRA_INPUT_BODY'))
    assert.ok(!disabled.includes('执行\\n/extra-input'))
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// 线程 config 的 skills（codex 的 SessionFlags 层）：真实 CLI 里按会话关掉指定的 Skill 和 Claude Code 自带的 Skill
test('SKILLS-008：线程 config 的 skills 按会话关掉 Skill，别的会话不受影响', {
  timeout: 90_000,
}, async () => {
  const home = await realpath(await mkdtemp('/tmp/native-skills-thread-'))
  const cwd = join(home, 'project')
  const effect = join(cwd, 'thread-effect.txt')
  const path = await writeSkill(join(cwd, '.claude', 'skills'), 'thread-fixture', effect)
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  // 自带的 Skill 关掉时，Skill 工具调用它就是错误结果
  const bundled = async (threadId: string, id: string): Promise<boolean> => {
    let failed = false
    model.enqueue(() => [{ type: 'tool_use', id, name: 'Skill', input: { skill: 'simplify' } }])
    model.enqueue((request) => {
      failed = toolResult(request, id).is_error === true
      return [{ type: 'text', text: 'done' }]
    })
    const { turn } = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Invoke the bundled skill.' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    return failed
  }
  try {
    const start = (config?: Record<string, unknown>) =>
      client.request('thread/start', {
        cwd,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        ...(config ? { config } : {}),
      })
    const scoped = await start({
      skills: { config: [{ path, enabled: false }], bundled: { enabled: false } },
    })
    await invokeSkill(client, model, scoped.thread.id, 'thread-fixture', false, 'toolu_scoped')
    await assert.rejects(access(effect), '线程里关掉的 Skill 不执行')
    assert.equal(await bundled(scoped.thread.id, 'toolu_bundled_off'), true, '自带的 Skill 关掉了')
    const plain = await start()
    await invokeSkill(client, model, plain.thread.id, 'thread-fixture', true, 'toolu_plain')
    assert.equal(await readFile(effect, 'utf8'), 'NATIVE_SKILL_EXECUTED\n')
    assert.equal(
      await bundled(plain.thread.id, 'toolu_bundled_on'),
      false,
      '别的会话照常有自带的 Skill',
    )
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
