import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { openStage } from './fixtures/in-process.mjs'
import { isolatedEnv } from './fixtures/isolated-env.mjs'

const kindOf = (item: unknown) => (item as { kind?: string } | undefined)?.kind

test('隔离入口：3835 个已结束回合不阻塞启动，仍可读历史并完成新回合', {
  timeout: 40_000,
}, async (t) => {
  const stage = await openStage('startup-entry')
  let child: ReturnType<typeof spawn> | undefined
  try {
    const client = await stage.connect('seed')
    const { thread } = await client.request('thread/start', { cwd: stage.directory })
    const db = Reflect.get(stage.store, 'db') as DatabaseSync
    const body = JSON.stringify([
      { type: 'agentMessage', id: 'answer', text: '虚构历史'.repeat(5200) },
    ])
    const put = db.prepare('INSERT INTO turns(id,thread_id,status,items_json) VALUES(?,?,?,?)')
    db.exec('BEGIN')
    for (let i = 0; i < 3835; i++) put.run(`history-${i}`, thread.id, 'completed', body)
    db.exec('COMMIT')
    const began = performance.now()
    const proc = spawn(
      process.execPath,
      [
        resolve('packages/claude/dist/claude/src/adapter.mjs'),
        'app-server',
        '--listen',
        'stdio://',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...isolatedEnv,
          HOME: stage.directory,
          USERPROFILE: stage.directory,
          CHA_CLAUDE_HOME: stage.directory,
          CODEX_HOME: join(stage.directory, 'codex'),
          CHA_CLAUDE_MOCK: '1',
          CHA_CLAUDE_MODELS: 'sonnet',
          NODE_NO_WARNINGS: '1',
        },
      },
    )
    child = proc
    const lines = createInterface({ input: proc.stdout })
    const messages: any[] = []
    let stderr = ''
    proc.stderr.on('data', (data) => {
      stderr += data
    })
    lines.on('line', (line) => messages.push(JSON.parse(line)))
    const until = async (find: () => any, limit = 5000) => {
      const end = Date.now() + limit
      while (Date.now() < end) {
        const result = find()
        if (result) return result
        assert.equal(child?.exitCode, null, stderr)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error(`隔离入口未就绪：${stderr}`)
    }
    const request = async (id: number, method: string, params: unknown) => {
      proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      const response = await until(() => messages.find((message) => message.id === id), 30_000)
      assert.equal(response.error, undefined, JSON.stringify(response.error))
      return response.result
    }
    await request(1, 'initialize', { clientInfo: { name: 'startup-fixture', version: '1' } })
    const startupMs = Math.round(performance.now() - began)
    assert.ok(startupMs < 30_000)
    t.diagnostic(JSON.stringify({ rows: 3835, bytes: Buffer.byteLength(body) * 3835, startupMs }))
    const page = await request(2, 'thread/turns/list', { threadId: thread.id, limit: 1 })
    assert.equal(page.data.length, 1)
    const started = await request(3, 'turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'hello' }],
    })
    await until(() =>
      messages.find(
        (message) =>
          message.method === 'turn/completed' && message.params.turn.id === started.turn.id,
      ),
    )
    lines.close()
  } finally {
    if (child && child.exitCode === null) {
      const closed = once(child, 'close')
      child.kill('SIGTERM')
      const force = setTimeout(() => child?.kill('SIGKILL'), 5000)
      await closed
      clearTimeout(force)
    }
    await stage.dispose()
  }
})

test('启动恢复不物化已结束历史；单回合首次读取才修正，后续读取不重复修正', async () => {
  const stage = await openStage('startup-history')
  try {
    const client = await stage.connect('fixture')
    const { thread } = await client.request('thread/start', { cwd: stage.directory })
    const db = Reflect.get(stage.store, 'db') as DatabaseSync
    const body = JSON.stringify([
      { type: 'agentMessage', id: 'answer', text: '虚构正文'.repeat(8000) },
    ])
    const stale = JSON.stringify([{ type: 'subAgentActivity', id: 'child', kind: 'started' }])
    const put = db.prepare('INSERT INTO turns(id,thread_id,status,items_json) VALUES(?,?,?,?)')
    db.exec('BEGIN')
    for (let i = 0; i < 512; i++) put.run(`history-${i}`, thread.id, 'completed', body)
    put.run('stale', thread.id, 'interrupted', stale)
    db.exec('COMMIT')
    const normalize = Reflect.get(stage.store, 'terminalizeStaleItems') as (
      ...args: unknown[]
    ) => string
    let normalized = 0
    Reflect.set(stage.store, 'terminalizeStaleItems', (...args: unknown[]) => {
      normalized++
      return normalize.apply(stage.store, args)
    })
    assert.equal(stage.store.recoverStaleInProgressTurns(), 0)
    assert.equal(normalized, 0, '不能为启动解析任何已结束历史')
    assert.equal(
      db.prepare('SELECT items_json FROM turns WHERE id=?').get('stale')?.items_json,
      stale,
    )
    assert.equal(kindOf(stage.store.getTurn('stale')?.items[0]), 'interrupted')
    assert.equal(normalized, 1)
    assert.equal(kindOf(stage.store.getTurn('stale')?.items[0]), 'interrupted')
    assert.equal(normalized, 1, '同一进程不反复清理同一回合')
    assert.equal(stage.store.getTurn('history-511')?.items[0]?.type, 'agentMessage')
    assert.equal(normalized, 2, '只处理实际打开的那一条')
  } finally {
    await stage.dispose()
  }
})

test('恢复只修正启动前的残留；新回合和重新写入的历史保留后台活动', async () => {
  const stage = await openStage('startup-new-background')
  try {
    const client = await stage.connect('fixture')
    const { thread } = await client.request('thread/start', { cwd: stage.directory })
    const turn = (id: string) => ({
      id,
      threadId: thread.id,
      status: 'completed' as const,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1000,
      diff: '',
      error: null,
      items: [{ type: 'subAgentActivity', id: 'child', kind: 'started' }] as any,
    })
    stage.store.upsertTurn(turn('rewritten'))
    stage.store.upsertTurn(turn('existing'))
    stage.store.recoverStaleInProgressTurns()
    stage.store.upsertTurn(turn('new-background'))
    stage.store.upsertTurn(turn('rewritten'))
    assert.equal(kindOf(stage.store.getTurn('new-background')?.items[0]), 'started')
    assert.equal(kindOf(stage.store.getTurn('rewritten')?.items[0]), 'started')
    assert.deepEqual(
      stage.store.getTurn('existing')?.items,
      [],
      '完成回合的旧活动标记仍按原规则移除',
    )
  } finally {
    await stage.dispose()
  }
})

for (const action of ['read', 'append', 'update']) {
  test(`逐条${action}先修正旧历史，不能清掉启动后新增的后台活动`, async () => {
    const stage = await openStage(`startup-items-${action}`)
    try {
      const client = await stage.connect('fixture')
      const { thread } = await client.request('thread/start', { cwd: stage.directory })
      stage.store.upsertTurn({
        id: 'terminal',
        threadId: thread.id,
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
        durationMs: 1000,
        diff: '',
        error: null,
        items: [
          { type: 'subAgentActivity', id: 'old', kind: 'started' },
          { type: 'agentMessage', id: 'tail', text: '旧历史' },
        ] as any,
      })
      stage.store.recoverStaleInProgressTurns()
      if (action === 'read') {
        assert.equal(stage.store.getItem('terminal', 'old'), null)
      } else {
        if (action === 'append')
          stage.store.appendItem('terminal', {
            type: 'subAgentActivity',
            id: 'fresh',
            kind: 'started',
          } as any)
        else
          stage.store.updateItem(
            'terminal',
            'tail',
            () => ({ type: 'subAgentActivity', id: 'tail', kind: 'started' }) as any,
          )
        const items = stage.store.getTurn('terminal')?.items
        assert.equal(
          items?.some((item) => item.id === 'old'),
          false,
        )
        assert.equal(
          kindOf(items?.find((item) => item.id === (action === 'append' ? 'fresh' : 'tail'))),
          'started',
        )
      }
    } finally {
      await stage.dispose()
    }
  })
}

test('活动回合与线程状态仍在启动时收尾；失败工具不得伪造成功或重放', async () => {
  const stage = await openStage('startup-active')
  try {
    const client = await stage.connect('fixture')
    const { thread } = await client.request('thread/start', { cwd: stage.directory })
    stage.store.reserveTool(thread.id, 'uncertain', 'fixture-hash')
    stage.store.upsertTurn({
      id: 'active',
      threadId: thread.id,
      status: 'inProgress',
      startedAt: 1,
      completedAt: null,
      durationMs: null,
      diff: '',
      error: null,
      items: [
        { type: 'dynamicToolCall', id: 'uncertain', status: 'inProgress', success: null },
      ] as any,
    })
    const db = Reflect.get(stage.store, 'db') as DatabaseSync
    db.prepare('UPDATE threads SET status_json=? WHERE id=?').run(
      JSON.stringify({ type: 'active', activeFlags: [] }),
      thread.id,
    )
    assert.equal(stage.store.recoverStaleInProgressTurns(), 1)
    assert.equal(stage.store.getThread(thread.id)?.status.type, 'idle')
    const recovered = stage.store.getTurn('active')
    assert.equal(recovered?.status, 'interrupted')
    const item = recovered?.items[0]
    assert.equal(item?.type, 'dynamicToolCall')
    if (item?.type === 'dynamicToolCall') {
      assert.equal(item.status, 'failed')
      assert.equal(item.success, null)
    }
    assert.throws(() => stage.store.reserveTool(thread.id, 'uncertain', 'fixture-hash'), /不确定/)
  } finally {
    await stage.dispose()
  }
})
