import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

async function fixture(hooks: (effect: string) => Record<string, unknown>) {
  const home = await realpath(await mkdtemp('/tmp/native-hooks-'))
  const cwd = join(home, 'project')
  const effect = join(cwd, 'hook-effects.txt')
  await mkdir(join(cwd, '.claude'), { recursive: true })
  await writeFile(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: hooks(effect) }))
  const model = new MockLLM()
  const endpoint = await model.start()
  const client = await ProtocolClient.start(home, endpoint)
  const { thread } = await client.request('thread/start', {
    cwd,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  })
  return { home, cwd, effect, model, endpoint, client, thread }
}

const command = (value: string, timeout = 10) => ({
  hooks: [{ type: 'command', command: value, timeout }],
})
const hookItems = (turn: any): any[] => turn.items.filter((item: any) => item.type === 'hookPrompt')
const itemText = (item: any): string =>
  item.fragments.map((fragment: any) => fragment.text).join('\n')

test('HOOKS-001：真实目录来源、禁用执行、会话 cwd 和父目录不误继承', {
  timeout: 60_000,
}, async () => {
  const f = await fixture((effect) => ({
    SessionStart: [command(`printf 'PROJECT\\n' >> ${JSON.stringify(effect)}`)],
  }))
  try {
    const userPath = join(f.home, 'claude', 'settings.json')
    const localPath = join(f.cwd, '.claude', 'settings.local.json')
    await writeFile(
      userPath,
      JSON.stringify({
        hooks: { UserPromptSubmit: [command(`printf 'USER\\n' >> ${JSON.stringify(f.effect)}`)] },
      }),
    )
    await writeFile(
      localPath,
      JSON.stringify({
        disableAllHooks: true,
        hooks: { Stop: [command(`printf 'LOCAL\\n' >> ${JSON.stringify(f.effect)}`)] },
      }),
    )
    const list = async () => (await f.client.request('hooks/list')).data[0]
    const before = await list()
    assert.equal(before.cwd, f.cwd)
    assert.deepEqual(before.errors, [])
    assert.equal(before.hooks.length, 3)
    assert.ok(before.hooks.every((hook: any) => !hook.enabled))
    assert.deepEqual(
      new Set(before.hooks.map((hook: any) => hook.sourcePath)),
      new Set([userPath, localPath, join(f.cwd, '.claude', 'settings.json')]),
    )
    assert.equal(f.model.requests.length, 0, '目录读取不能调用模型')
    for (const cwds of ['invalid', [12], ['relative']])
      await f.client.raw('hooks/list', { cwds }, -32602)
    f.model.enqueue(() => [{ type: 'text', text: 'HOOKS_DISABLED' }])
    const { turn } = await f.client.request('turn/start', {
      threadId: f.thread.id,
      input: [{ type: 'text', text: 'Answer briefly.' }],
    })
    assert.equal((await f.client.completed(turn.id)).status, 'completed')
    await assert.rejects(readFile(f.effect), '禁用配置必须真正阻止 Hook 副作用')
    assert.equal(
      f.client.trace.filter(
        (entry) => entry.method === 'item/started' && entry.params.item.type === 'hookPrompt',
      ).length,
      0,
    )
    const child = join(f.cwd, 'child')
    await mkdir(child)
    const childList = (await f.client.request('hooks/list', { cwds: [child] })).data[0]
    assert.deepEqual(
      childList.hooks.map((hook: any) => hook.sourcePath),
      [userPath],
      '原生项目 Hook 配置不沿用父目录设置',
    )
    const childThread = (
      await f.client.request('thread/start', {
        cwd: child,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      })
    ).thread
    f.model.enqueue(() => [{ type: 'text', text: 'CHILD_SCOPE' }])
    const childTurn = (
      await f.client.request('turn/start', {
        threadId: childThread.id,
        input: [{ type: 'text', text: 'Answer briefly.' }],
      })
    ).turn
    assert.equal((await f.client.completed(childTurn.id)).status, 'completed')
    assert.equal(
      await readFile(f.effect, 'utf8'),
      'USER\n',
      '只执行原生用户 Hook，不执行父项目 Hook',
    )
    await writeFile(localPath, '{broken')
    const broken = (await f.client.request('hooks/list', { cwds: [f.cwd] })).data[0]
    assert.equal(broken.errors.length, 1)
    assert.equal(broken.errors[0].path, localPath)
    f.model.assertConsumed()
  } finally {
    await f.client.close()
    await f.model.close()
    await rm(f.home, { recursive: true, force: true })
  }
})

test('HOOKS-002：真实 CLI Hook 开始结束同一原生 ID，真实副作用与历史一致', {
  timeout: 60_000,
}, async () => {
  const f = await fixture((effect) =>
    Object.fromEntries(
      ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'].map((event) => [
        event,
        [
          {
            ...command(
              `printf '${event}\\n' >> ${JSON.stringify(effect)}; printf 'VISIBLE_${event}'`,
            ),
            ...(['PreToolUse', 'PostToolUse'].includes(event) ? { matcher: 'Read' } : {}),
          },
        ],
      ]),
    ),
  )
  try {
    const source = join(f.cwd, 'source.txt')
    await writeFile(source, 'HOOK_REAL_SOURCE')
    f.model.enqueue(() => [
      { type: 'tool_use', id: 'toolu_hook_read', name: 'Read', input: { file_path: source } },
    ])
    f.model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages), /HOOK_REAL_SOURCE/)
      return [{ type: 'text', text: 'HOOK_REAL_DONE' }]
    })
    const { turn } = await f.client.request('turn/start', {
      threadId: f.thread.id,
      input: [{ type: 'text', text: 'Read the fixture source once.' }],
    })
    const completed = await f.client.completed(turn.id)
    assert.equal(completed.status, 'completed')
    assert.deepEqual((await readFile(f.effect, 'utf8')).trim().split('\n'), [
      'SessionStart',
      'PreToolUse',
      'PostToolUse',
      'Stop',
    ])
    const starts = f.client.trace.filter(
      (entry) => entry.method === 'item/started' && entry.params.item.type === 'hookPrompt',
    )
    const ends = f.client.trace.filter(
      (entry) => entry.method === 'item/completed' && entry.params.item.type === 'hookPrompt',
    )
    assert.equal(starts.length, 4)
    assert.equal(ends.length, 4)
    assert.deepEqual(
      starts.map((entry) => entry.params.item.id),
      ends.map((entry) => entry.params.item.id),
    )
    for (const entry of ends) {
      const item = entry.params.item
      assert.equal(new Set(item.fragments.map((fragment: any) => fragment.hookRunId)).size, 1)
      assert.match(itemText(item), /结果: success/)
      assert.equal(
        item.fragments.filter((fragment: any) => fragment.text.startsWith('VISIBLE_')).length,
        1,
      )
      assert.ok(
        f.client.trace.indexOf(entry) <
          f.client.trace.findIndex((value) => value.method === 'turn/completed'),
      )
    }
    const history = (
      await f.client.request('thread/read', { threadId: f.thread.id, includeTurns: true })
    ).thread
    assert.deepEqual(
      hookItems(history.turns[0]),
      ends.map((entry) => entry.params.item),
    )
    f.model.assertConsumed()
  } finally {
    await f.client.close()
    await f.model.close()
    await rm(f.home, { recursive: true, force: true })
  }
})

test('HOOKS-003：真实 Hook 命令非零退出保留错误终态而非成功', { timeout: 60_000 }, async () => {
  const f = await fixture((effect) => ({
    SessionStart: [
      command(
        `printf 'FAILED_ONCE\\n' >> ${JSON.stringify(effect)}; printf HOOK_ERROR >&2; exit 1`,
      ),
    ],
  }))
  try {
    f.model.enqueue(() => [{ type: 'text', text: 'MODEL_COMPLETED_AFTER_HOOK_FAILURE' }])
    const { turn } = await f.client.request('turn/start', {
      threadId: f.thread.id,
      input: [{ type: 'text', text: 'Answer briefly.' }],
    })
    await f.client.completed(turn.id)
    const history = (
      await f.client.request('thread/read', { threadId: f.thread.id, includeTurns: true })
    ).thread
    const hooks = hookItems(history.turns[0])
    assert.equal(hooks.length, 1)
    assert.match(itemText(hooks[0]), /结果: error/)
    assert.match(itemText(hooks[0]), /退出码: 1/)
    assert.match(itemText(hooks[0]), /HOOK_ERROR/)
    assert.equal(await readFile(f.effect, 'utf8'), 'FAILED_ONCE\n')
    f.model.assertConsumed()
  } finally {
    await f.client.close()
    await f.model.close()
    await rm(f.home, { recursive: true, force: true })
  }
})

for (const mode of ['interrupt', 'crash'] as const)
  test(`HOOKS-003：真实 Hook 等待时 ${mode}，恢复唯一不确定终态且不重放`, {
    timeout: 60_000,
  }, async () => {
    const f = await fixture((effect) => ({
      SessionStart: [
        command(
          `printf 'STARTED_ONCE\\n' >> ${JSON.stringify(effect)}; sleep 3; printf HOOK_LATE_OUTPUT`,
        ),
      ],
    }))
    let client = f.client
    try {
      const { turn } = await client.request('turn/start', {
        threadId: f.thread.id,
        input: [{ type: 'text', text: 'Answer after the hook.' }],
      })
      await client.notification('item/started', (params) => params.item.type === 'hookPrompt')
      for (let tries = 0; tries < 100; tries++) {
        if ((await readFile(f.effect, 'utf8').catch(() => '')).includes('STARTED_ONCE')) break
        await delay(10)
      }
      assert.equal(await readFile(f.effect, 'utf8'), 'STARTED_ONCE\n')
      if (mode === 'interrupt') {
        await client.request('turn/interrupt', { threadId: f.thread.id, turnId: turn.id })
        assert.equal((await client.completed(turn.id)).status, 'interrupted')
        assert.equal(
          client.trace.filter(
            (entry) => entry.method === 'item/completed' && entry.params.item.type === 'hookPrompt',
          ).length,
          1,
        )
      } else client.crash()
      await client.close()
      client = await ProtocolClient.start(f.home, f.endpoint)
      const resumed = await client.request('thread/resume', { threadId: f.thread.id })
      const hooks = hookItems(resumed.thread.turns[0])
      assert.equal(hooks.length, 1)
      assert.match(itemText(hooks[0]), mode === 'crash' ? /结果: unknown/ : /结果: cancelled/)
      assert.doesNotMatch(itemText(hooks[0]), /结果: success/)
      await delay(3300)
      assert.equal(await readFile(f.effect, 'utf8'), 'STARTED_ONCE\n', '恢复不得再次执行 Hook')
      assert.equal(f.model.requests.length, 0, '中断及恢复不得发送模型请求')
      const read = (
        await client.request('thread/read', { threadId: f.thread.id, includeTurns: true })
      ).thread
      assert.deepEqual(hookItems(read.turns[0]), hooks)
    } finally {
      await client.close()
      await f.model.close()
      await rm(f.home, { recursive: true, force: true })
    }
  })

test('HOOKS-002：真实 Hook 进度累计快照只保留一次输出和一个终态', { timeout: 60_000 }, async () => {
  const f = await fixture((effect) => ({
    SessionStart: [
      command(
        `printf 'PROGRESS_ONCE\\n' >> ${JSON.stringify(effect)}; printf FIRST; sleep 2; printf SECOND; sleep 2; printf THIRD`,
      ),
    ],
  }))
  try {
    f.model.enqueue(() => [{ type: 'text', text: 'AFTER_PROGRESS' }])
    const { turn } = await f.client.request('turn/start', {
      threadId: f.thread.id,
      input: [{ type: 'text', text: 'Answer briefly.' }],
    })
    await f.client.notification('item/started', (params) => params.item.type === 'hookPrompt')
    let observedProgress = false
    for (let attempt = 0; attempt < 80; attempt++) {
      const history = (
        await f.client.request('thread/read', { threadId: f.thread.id, includeTurns: true })
      ).thread
      const hook = hookItems(history.turns[0])[0]
      if (
        hook?.fragments.some(
          (fragment: any) => fragment.text === 'FIRST' || fragment.text === 'FIRSTSECOND',
        )
      ) {
        assert.doesNotMatch(itemText(hook), /结果:/)
        observedProgress = true
        break
      }
      await delay(50)
    }
    assert.equal(observedProgress, true, '必须真正观察到终态前的原生进度')
    assert.equal((await f.client.completed(turn.id)).status, 'completed')
    const history = (
      await f.client.request('thread/read', { threadId: f.thread.id, includeTurns: true })
    ).thread
    const hooks = hookItems(history.turns[0])
    assert.equal(hooks.length, 1)
    assert.deepEqual(
      hooks[0].fragments
        .filter((fragment: any) => fragment.text.includes('FIRST'))
        .map((fragment: any) => fragment.text),
      ['FIRSTSECONDTHIRD'],
    )
    assert.equal(
      f.client.trace.filter(
        (entry) => entry.method === 'item/completed' && entry.params.item.type === 'hookPrompt',
      ).length,
      1,
    )
    assert.equal(await readFile(f.effect, 'utf8'), 'PROGRESS_ONCE\n')
    f.model.assertConsumed()
  } finally {
    await f.client.close()
    await f.model.close()
    await rm(f.home, { recursive: true, force: true })
  }
})

test('HOOKS-003：真实 Hook 超时停止命令且不伪装成功', { timeout: 60_000 }, async () => {
  const f = await fixture((effect) => ({
    SessionStart: [
      command(
        `printf 'TIMEOUT_STARTED\\n' >> ${JSON.stringify(effect)}; sleep 3; printf 'AFTER_TIMEOUT\\n' >> ${JSON.stringify(effect)}`,
        1,
      ),
    ],
  }))
  try {
    f.model.enqueue(() => [{ type: 'text', text: 'AFTER_TIMEOUT' }])
    const { turn } = await f.client.request('turn/start', {
      threadId: f.thread.id,
      input: [{ type: 'text', text: 'Answer briefly.' }],
    })
    await f.client.completed(turn.id)
    const history = (
      await f.client.request('thread/read', { threadId: f.thread.id, includeTurns: true })
    ).thread
    const hooks = hookItems(history.turns[0])
    assert.equal(hooks.length, 1)
    assert.match(itemText(hooks[0]), /结果: (error|cancelled)/)
    await delay(3200)
    assert.equal(
      await readFile(f.effect, 'utf8'),
      'TIMEOUT_STARTED\n',
      '超时后不能继续执行余下命令',
    )
    f.model.assertConsumed()
  } finally {
    await f.client.close()
    await f.model.close()
    await rm(f.home, { recursive: true, force: true })
  }
})
