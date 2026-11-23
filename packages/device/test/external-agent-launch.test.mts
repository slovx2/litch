import assert from 'node:assert/strict'
import test from 'node:test'
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
