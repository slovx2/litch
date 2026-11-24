import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Terminals } from '../../acp/src/client-side.mjs'
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
  const options = {
    managers: {
      store: {
        manager: (id: string) =>
          id === 'm'
            ? { id: 'm', status: 'active', harness: managerHarness, threadId: 'm-thread' }
            : null,
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
      assignmentForManager: () => (assigned ? { identityId: 'bot', repoIds: ['r'] } : null),
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
  return {
    request,
    set(next: { state?: GithubAgentResolution['state']; assigned?: boolean }) {
      state = next.state ?? state
      assigned = next.assigned ?? assigned
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
