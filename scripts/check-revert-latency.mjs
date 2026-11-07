// 合成大历史，只用隔离 SQLite 和空运行时。JSON 解析字节数不受机器负载影响。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'revert-latency-'))
process.env.CHA_CLAUDE_HOME = home
process.env.CLAUDE_CONFIG_DIR = home
const { SessionStore } = await import('../packages/claude/dist/claude/src/store.mjs')
const { CodexClaudeAppServer } = await import('../packages/claude/dist/claude/src/server.mjs')
const store = new SessionStore(join(home, 'state.sqlite'))
const runtime = {
  runTurn: async () => {},
  steer: async () => {},
  interrupt: async () => {},
  stop: async () => {},
}
const server = new CodexClaudeAppServer(store, runtime)
const frames = []
const peer = { id: 'measure', close() {}, send: (frame) => frames.push(frame) }
let id = 0
const call = async (method, params) => {
  const next = ++id
  await server.handle(peer, { jsonrpc: '2.0', id: next, method, params })
  const frame = frames.find((value) => value.id === next)
  assert.ok(!frame.error, JSON.stringify(frame.error))
  return frame.result
}
try {
  await call('initialize', {
    clientInfo: { name: 'measure', title: null, version: '1' },
    capabilities: null,
  })
  const results = []
  for (const cut of [false, true]) {
    const { thread } = await call('thread/start', { cwd: home })
    for (let index = 0; index < 400; index++) {
      store.upsertTurn({
        id: `${thread.id}-${index}`,
        threadId: thread.id,
        status: 'completed',
        startedAt: index,
        completedAt: index + 1,
        durationMs: 1,
        diff: '',
        error: null,
        items: [
          { id: 'user', type: 'userMessage', content: [{ type: 'text', text: '开头' }] },
          { id: 'answer', type: 'agentMessage', text: 'x'.repeat(100000) },
          { id: 'steer', type: 'userMessage', content: [{ type: 'text', text: '插话' }] },
        ],
      })
    }
    const parse = JSON.parse
    let parsed = 0
    JSON.parse = (text, ...args) => {
      parsed += typeof text === 'string' ? text.length : 0
      return parse(text, ...args)
    }
    const start = performance.now()
    let response
    try {
      response = await call('thread/revert', {
        threadId: thread.id,
        beforeTurnId: `${thread.id}-399`,
        ...(cut ? { beforeItemId: 'steer' } : {}),
      })
    } finally {
      JSON.parse = parse
    }
    results.push({
      cut,
      ms: performance.now() - start,
      parsed,
      responseBytes: JSON.stringify(response).length,
    })
  }
  mkdirSync('.artifacts/stop-latency', { recursive: true })
  writeFileSync(
    `.artifacts/stop-latency/revert-${process.argv.includes('--baseline') ? 'baseline' : 'fixed'}.json`,
    JSON.stringify(results, null, 2),
  )
  console.log(JSON.stringify(results))
  if (!process.argv.includes('--baseline'))
    for (const result of results) assert.ok(result.parsed < 1000000, JSON.stringify(result))
} finally {
  await server.stop()
  rmSync(home, { recursive: true, force: true })
}
