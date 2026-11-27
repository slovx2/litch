import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { acpModuleUrl } from '../src/backend-loader.mjs'

async function waitFor<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value != null) return value
    await delay(10)
  }
  assert.fail(`等待超时：${label}`)
}

const readJsonl = async (path: string): Promise<any[]> =>
  (await readFile(path, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

test('Antigravity 正式入口记录 ACP prompt 与审批边界，不把日志环境或内容传出去', async () => {
  const home = await mkdtemp(join(tmpdir(), 'litch-agy-timing-'))
  const cwd = join(home, 'project')
  const logDir = join(home, 'logs', 'agy')
  const path = join(logDir, 'rpc.jsonl')
  const fakeLog = join(home, 'fake.jsonl')
  await mkdir(cwd)
  const mock = fileURLToPath(new URL('../test/fake-agent.mjs', acpModuleUrl()))
  const entry = fileURLToPath(new URL('../src/adapter.mjs', import.meta.url))
  const child = spawn(process.execPath, [entry, 'app-server'], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: home,
      XDG_CACHE_HOME: home,
      XDG_STATE_HOME: home,
      XDG_DATA_HOME: home,
      CHA_ANTIGRAVITY_HOME: join(home, 'state'),
      CHA_AGY_CLI: process.execPath,
      CHA_AGY_ARGS: `"${mock}"`,
      FAKE_ACP_STATE: join(home, 'fake-state.json'),
      FAKE_ACP_LOG: fakeLog,
      LITCH_LOG_DIR: logDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  child.stderr.resume()
  const frames: any[] = []
  createInterface({ input: child.stdout }).on('line', (line) => frames.push(JSON.parse(line)))
  const send = (frame: unknown) => child.stdin.write(`${JSON.stringify(frame)}\n`)
  let sequence = 0
  const call = async (method: string, params: object = {}) => {
    const id = ++sequence
    send({ id, method, params })
    const frame = await waitFor(() => frames.find((f) => f.id === id && !f.method), method)
    assert.equal(frame.error, undefined)
    return frame.result
  }
  try {
    await call('initialize')
    const { thread } = await call('thread/start', { cwd })
    const { turn } = await call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'run 夹具私密输入' }],
    })
    const approval = await waitFor(
      () => frames.find((f) => f.method === 'item/commandExecution/requestApproval'),
      '审批卡',
    )
    const arrived = await waitFor(
      async () =>
        (await readJsonl(path)).find(
          (row) =>
            row.event === 'acp.request.started' && row.method === 'session/request_permission',
        ),
      '批准前的到达日志',
    )
    send({ id: approval.id, result: { decision: 'accept' } })
    const done = await waitFor(
      () => frames.find((f) => f.method === 'turn/completed' && f.params.turn.id === turn.id),
      '回合完成',
    )
    assert.equal(done.params.turn.status, 'completed')
    await waitFor(
      async () => (await readJsonl(path)).find((row) => row.event === 'acp.turn.ended'),
      '回合结束日志',
    )
    const rows = (await readJsonl(path)).filter((row) => row.event.startsWith('acp.'))
    assert.ok(rows.every((row) => row.threadId === thread.id && row.turnId === turn.id && row.ts))
    const sent = rows.find((row) => row.event === 'acp.prompt.sent')
    const response = rows.find((row) => row.event === 'acp.prompt.ended')
    const answered = rows.find(
      (row) => row.event === 'acp.request.ended' && row.method === arrived.method,
    )
    assert.equal(sent.method, 'session/prompt')
    assert.equal(response.method, sent.method)
    assert.equal(response.requestId, sent.requestId)
    assert.equal(response.outcome, 'ok')
    assert.equal(response.stopReason, 'end_turn')
    assert.equal(answered.requestId, arrived.requestId)
    assert.equal(answered.toolCallId, 'call-run')
    assert.equal(answered.outcome, 'ok')
    assert.equal(answered.permissionOutcome, 'selected')
    assert.ok(answered.ts >= arrived.ts && answered.durationMs >= 0)
    assert.equal(rows.at(-1).outcome, 'completed')
    assert.doesNotMatch(await readFile(path, 'utf8'), /夹具私密输入|echo hi|跑完了/)
    assert.equal((await readJsonl(fakeLog)).find((row) => row.started)?.hasLogDir, false)
  } finally {
    child.stdin.end()
    await exited
    await rm(home, { recursive: true, force: true })
  }
})
