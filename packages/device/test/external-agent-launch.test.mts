import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Terminals } from '../../acp/src/client-side.mjs'
import { threadHook } from '../../acp/src/thread-hook.mjs'
import { encodeThread } from '../../antigravity/src/id-space.mjs'
import { commandContext } from '../../antigravity/src/server.mjs'
import threadPlugin from '../../opencode/src/thread-plugin.mjs'
import { BackgroundShells } from '../../shared/src/background-shell.mjs'
import { githubCommandThread } from '../src/external/device-agent-command.mjs'
import { DeviceAgentLaunch } from '../src/external/device-agent-launch.mjs'
import type {
  GithubAgentActor,
  GithubAgentResolution,
} from '../src/external/secrets-agent-login.mjs'

// 经理的注入随会话树传给它派出的每一层工作线，不论经理和工作线各用哪个 harness。
const harnesses = ['codex', 'claude-code', 'pi', 'dsh', 'opencode', 'gemini']
const threadVariable: Record<string, string> = {
  codex: 'CODEX_THREAD_ID',
  pi: 'PI_SESSION_ID',
  dsh: 'DSH_SESSION_ID',
}

function launcher(managerHarness: string, lines: Record<string, string>) {
  let state: GithubAgentResolution['state'] = 'active'
  let assigned = true
  let inject = true
  let status = 'active'
  const options = {
    managers: {
      store: {
        manager: (id: string) =>
          id === 'm' ? { id: 'm', status, harness: managerHarness, threadId: 'm-thread' } : null,
        managers: () => [{ id: 'm', status, harness: managerHarness, threadId: 'm-thread' }],
      },
      lines: {
        mark: (threadId: string) =>
          threadId === 'm-thread'
            ? { managerId: 'm', role: 'manager' }
            : threadId in lines
              ? { managerId: 'm', role: 'line' }
              : null,
      },
      tree: {
        host: {
          index: {
            archived: () => false,
            lookup: (threadId: string) =>
              lines[threadId] ?? (threadId === 'ordinary' ? 'codex' : null),
          },
        },
      },
      resets: { refusal: () => null, held: () => false },
    },
    configuration: {
      assignmentForManager: () =>
        assigned ? { identityId: 'bot', repoIds: ['r'], injectCredentials: inject } : null,
    },
  }
  const launch = new DeviceAgentLaunch(options as never)
  const login = {
    environment: (actor: GithubAgentActor, base: NodeJS.ProcessEnv) => ({
      resolution: { state },
      ghPath: '/device/gh',
      env: { ...base, ACTOR: `${actor.kind}:${actor.threadId}` },
      dispose() {},
    }),
  }
  Object.assign(launch, { login })
  const request = (threadId: string, harness: string) =>
    (launch as unknown as { request(raw: unknown): Promise<Record<string, unknown>> }).request({
      action: 'start',
      threadId,
      harness,
      base: { PATH: '/usr/bin' },
    })
  const probe = async (threadId: string, harness: string) =>
    (
      (await (
        launch as unknown as { request(raw: unknown): Promise<{ injected?: boolean }> }
      ).request({ action: 'probe', threadId, harness })) as { injected?: boolean }
    ).injected === true
  const configured = async () =>
    (
      (await (
        launch as unknown as { request(raw: unknown): Promise<{ injected?: boolean }> }
      ).request({ action: 'configured' })) as { injected?: boolean }
    ).injected === true
  return {
    request,
    probe,
    configured,
    set(next: {
      state?: GithubAgentResolution['state']
      assigned?: boolean
      inject?: boolean
      status?: string
    }) {
      state = next.state ?? state
      assigned = next.assigned ?? assigned
      inject = next.inject ?? inject
      status = next.status ?? status
    },
  }
}

test('经理、工作线、子线在各 harness 上都拿到注入；未路由和注入关闭不注入', async () => {
  for (const [index, managerHarness] of harnesses.entries()) {
    const lineHarness = harnesses[(index + 1) % harnesses.length] ?? 'codex'
    const childHarness = harnesses[(index + 2) % harnesses.length] ?? 'codex'
    const f = launcher(managerHarness, { line: lineHarness, 'line-of-line': childHarness })
    const label = `${managerHarness} → ${lineHarness} → ${childHarness}`
    for (const [thread, harness, actor] of [
      ['m-thread', managerHarness, 'manager:m-thread'],
      ['line', lineHarness, 'workline:line'],
      ['line-of-line', childHarness, 'workline:line-of-line'],
    ] as const) {
      const granted = await f.request(thread, harness)
      assert.equal(granted.ghPath, '/device/gh', `${label} ${thread}`)
      assert.equal(typeof granted.lease, 'string')
      assert.deepEqual(granted.env, { PATH: '/usr/bin', ACTOR: actor })
    }
    assert.deepEqual(await f.request('line', childHarness === lineHarness ? 'x' : childHarness), {})
    assert.deepEqual(await f.request('ordinary', 'codex'), {}, '未被路由的普通会话不注入')
    // 凭据失效仍给租约，由助手报错；注入关闭（host）或没有身份则不注入，用宿主 gh。
    f.set({ state: 'broken' })
    assert.equal((await f.request('line-of-line', childHarness)).ghPath, '/device/gh')
    f.set({ state: 'host' })
    assert.deepEqual(await f.request('line', lineHarness), {})
    f.set({ state: 'active', assigned: false })
    assert.deepEqual(await f.request('m-thread', managerHarness), {})
  }
})

test('命令入口按 harness 取会话号', () => {
  for (const harness of harnesses) {
    const variable = threadVariable[harness] ?? 'LITCH_THREAD_ID'
    const env = { LITCH_DEVICE_GITHUB_HARNESS: harness, [variable]: `t-${harness}` }
    assert.equal(githubCommandThread(env), `t-${harness}`)
    assert.equal(githubCommandThread({ ...env, LITCH_DEVICE_GITHUB_HARNESS: undefined }), undefined)
  }
})

// 各 harness 自己起的命令：环境里的会话号就是它的 Litch 线程号，设备按它发租约。
async function leased(harness: string, env: NodeJS.ProcessEnv, threadId: string, label: string) {
  const thread = githubCommandThread({ ...env, LITCH_DEVICE_GITHUB_HARNESS: harness })
  assert.equal(thread, threadId, label)
  const f = launcher(harness, { [threadId]: harness, 'ordinary-line': 'codex' })
  const granted = await f.request(thread ?? '', harness)
  assert.equal(granted.ghPath, '/device/gh', label)
  assert.equal(typeof granted.lease, 'string', label)
}

test('OpenCode 的 shell.env 插件写上会话号，子代理的命令算在发起它的会话名下', async () => {
  const parents: Record<string, string | undefined> = { ses_child: 'ses_line', ses_line: undefined }
  let asked = 0
  const client = {
    session: {
      get: async ({ path }: { path: { id: string } }) => {
        asked++
        return path.id in parents ? { data: { parentID: parents[path.id] } } : { data: null }
      },
    },
  }
  const hooks = await threadPlugin.server({ client, directory: '/repo' })
  const run = async (sessionID?: string) => {
    const output = { env: {} as Record<string, string> }
    await hooks['shell.env']({ cwd: '/repo', ...(sessionID ? { sessionID } : {}) }, output)
    return output.env
  }
  const own = await run('ses_line')
  assert.equal(own.LITCH_THREAD_ID, 'ses_line')
  await leased('opencode', own, 'ses_line', 'opencode 会话')
  const child = await run('ses_child')
  assert.equal(child.LITCH_THREAD_ID, 'ses_line')
  await leased('opencode', child, 'ses_line', 'opencode 子代理')
  const before = asked
  await run('ses_child')
  assert.equal(asked, before, '上下级查过一次就记住')
  assert.equal((await run('ses_missing')).LITCH_THREAD_ID, 'ses_missing', '查不到上级用自己的')
  assert.deepEqual(await run(), {}, '没有会话的命令（PTY）不写')
})

test('ACP 客户端终端的命令带 ACP 会话号', async () => {
  const terminals = new Terminals(() => {})
  for (const harness of ['gemini', 'qwen', 'acp']) {
    const sessionId = `acp-${harness}`
    const { terminalId } = terminals.create({
      command: 'printf %s "$LITCH_THREAD_ID"',
      sessionId,
    })
    await terminals.waitForExit({ terminalId })
    const printed = terminals.output({ terminalId }).output
    await leased(harness, { LITCH_THREAD_ID: printed }, sessionId, `${harness} 终端`)
  }
  await terminals.closeAll()
})

test('litch_shell 后台命令按 harness 带会话号', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-shell-thread-'))
  const saved = process.env.LITCH_DEVICE_GITHUB_HARNESS
  try {
    for (const [harness, variable] of [
      ['pi', 'PI_SESSION_ID'],
      ['opencode', 'LITCH_THREAD_ID'],
      ['acp', 'LITCH_THREAD_ID'],
    ] as const) {
      process.env.LITCH_DEVICE_GITHUB_HARNESS = harness
      const shells = new BackgroundShells(join(dir, harness), { changed() {}, finished() {} })
      const threadId = `shell-${harness}`
      const task = shells.start(threadId, { command: `printf %s "$${variable}"` }, dir)
      const { output } = await shells.read(threadId, task.id, { waitSeconds: 10 })
      await shells.close()
      await leased(harness, { [variable]: output }, threadId, `${harness} 后台命令`)
    }
  } finally {
    if (saved === undefined) delete process.env.LITCH_DEVICE_GITHUB_HARNESS
    else process.env.LITCH_DEVICE_GITHUB_HARNESS = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Antigravity 的 localharness 拿到路由给出去的会话号和设备入口', async () => {
  const threadId = encodeThread('sdk', 'cascade-1')
  const env = commandContext(
    { LITCH_DEVICE_SOCKET: '/state/device.sock', LITCH_DEVICE_GITHUB_HARNESS: 'agy', HOME: '/x' },
    threadId,
  )
  assert.deepEqual(env, {
    LITCH_THREAD_ID: 'agy:sdk:cascade-1',
    LITCH_DEVICE_SOCKET: '/state/device.sock',
    LITCH_DEVICE_GITHUB_HARNESS: 'agy',
  })
  await leased('agy', env, threadId, 'agy SDK')
})

test('probe 只回答会话是否已注入，不发租约', async () => {
  const f = launcher('gemini', { line: 'qwen' })
  assert.equal(await f.probe('m-thread', 'gemini'), true)
  assert.equal(await f.probe('line', 'qwen'), true)
  assert.equal(await f.probe('line', 'gemini'), false, 'harness 对不上')
  assert.equal(await f.probe('ordinary', 'codex'), false, '普通会话')
  f.set({ inject: false })
  assert.equal(await f.probe('m-thread', 'gemini'), false, '经理关了注入')
  f.set({ inject: true, assigned: false })
  assert.equal(await f.probe('m-thread', 'gemini'), false, '经理没分配身份')
})

test('configured 只回答设备上有没有在用的经理开着注入', async () => {
  const f = launcher('gemini', {})
  assert.equal(await f.configured(), true)
  f.set({ inject: false })
  assert.equal(await f.configured(), false, '注入关了')
  f.set({ inject: true, assigned: false })
  assert.equal(await f.configured(), false, '没分配身份')
  f.set({ assigned: true, status: 'ended' })
  assert.equal(await f.configured(), false, '经理已结束')
})

test('Qwen 的工具前钩子给已注入会话的命令写上会话号，其余不改', {
  skip: process.platform === 'win32',
}, async () => {
  const f = launcher('qwen', { 'acp-session-1': 'qwen', "bad'id": 'qwen' })
  const input = (sessionId: string, tool = 'run_shell_command') => ({
    session_id: sessionId,
    tool_name: tool,
    tool_input: { command: 'printf %s "$LITCH_THREAD_ID"', description: 'x' },
  })
  const hook = (raw: unknown) =>
    threadHook('qwen', '/state/device.sock', raw, (harness, threadId) => f.probe(threadId, harness))
  const result = (await hook(input('acp-session-1'))) as {
    hookSpecificOutput: { updatedInput: { command: string; description: string } }
  }
  const replaced = result.hookSpecificOutput.updatedInput
  assert.equal(replaced.description, 'x', '其余参数原样')
  const printed = execFileSync('bash', ['-c', replaced.command], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  })
  await leased('qwen', { LITCH_THREAD_ID: printed }, 'acp-session-1', 'qwen 钩子')
  assert.deepEqual(await hook(input('ordinary')), {}, '未注入的会话不改')
  assert.deepEqual(await hook(input('acp-session-1', 'read_file')), {}, '只改 shell')
  assert.deepEqual(await hook(input("bad'id")), {}, '会话号带特殊字符不改（即使已注入）')
  assert.deepEqual(await hook(null), {})
})

test('Gemini 会话进程：会话号从 LITCH_THREAD_ID_FILE 读出，拿得到租约', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-thread-file-'))
  try {
    const file = join(dir, 'thread.id')
    const env = { LITCH_THREAD_ID_FILE: file }
    assert.equal(githubCommandThread({ ...env, LITCH_DEVICE_GITHUB_HARNESS: 'gemini' }), undefined)
    writeFileSync(file, 'gemini-session-1\n')
    await leased('gemini', env, 'gemini-session-1', 'gemini 会话进程')
    assert.equal(
      githubCommandThread({ ...env, LITCH_DEVICE_GITHUB_HARNESS: 'gemini', LITCH_THREAD_ID: 'x' }),
      'x',
      'LITCH_THREAD_ID 优先',
    )
    assert.equal(
      githubCommandThread({ ...env, LITCH_DEVICE_GITHUB_HARNESS: 'pi' }),
      undefined,
      '自带会话号变量的 harness 不看文件',
    )
    writeFileSync(file, 'bad id')
    assert.equal(githubCommandThread({ ...env, LITCH_DEVICE_GITHUB_HARNESS: 'gemini' }), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
