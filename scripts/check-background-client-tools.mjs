// 后台子会话路由的真实进程验收：设备夹具、隔离 CLI、回环假模型；桌面执行方由 RPC 客户端模拟。
// 提供 CHA_CLAUDE_CLI、CHA_CODEX_CLI 后运行 npm run check:background-client-tools。不会打开子会话。
import assert from 'node:assert/strict'
import test from 'node:test'
import { clientToolSpecs } from '../packages/device/dist/protocol/src/client-tools-specs.mjs'
import {
  managerClient,
  managerReply,
  startManagerFixture,
  until,
} from './client-fixture-manager-check.mjs'
import { SESSIONS_HEARD } from './client-fixture-sessions.mjs'

test('M16：真实跨 harness 后台子会话的浏览器请求', { timeout: 360_000 }, async (t) => {
  assert.ok(process.env.CHA_CLAUDE_CLI, '请指定隔离的 Claude Code CLI')
  assert.ok(process.env.CHA_CODEX_CLI, '请指定隔离的 Codex CLI')
  const fixture = await startManagerFixture(t, {
    CHA_CLAUDE_CLI: process.env.CHA_CLAUDE_CLI,
    CHA_CODEX_CLI: process.env.CHA_CODEX_CLI,
  })
  const client = await managerClient(t, fixture.socket, ['litch_browser'])
  for (const [parent, child] of [
    ['claude-code', 'codex'],
    ['pi', 'claude-code'],
  ]) {
    const { thread } = await client.call('thread/start', {
      harness: parent,
      cwd: fixture.engines.cwd,
      dynamicTools: clientToolSpecs(['litch_browser', 'litch_sessions']),
    })
    const spec = {
      title: '后台浏览器验收',
      harness: child,
      kind: 'fresh',
      initiation: 'user_asked',
      worktree: false,
      wake_parent: false,
      background:
        '这是隔离设备夹具中的后台工具路由验收。模型和桌面执行器均为测试替身，只验证调用能抵达声明过能力的桌面连接并返回结果；不访问真实浏览器、不读取个人配置。',
      prompt: '浏览器：navigate {"url":"http://localhost/m16"}',
    }
    const { turn } = await client.call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: `会话：start ${JSON.stringify(spec)}`, text_elements: [] }],
    })
    const answer = await managerReply(client, thread.id, SESSIONS_HEARD, null, turn.id)
    const childId = JSON.parse(answer.slice(SESSIONS_HEARD.length).trim()).thread_id
    assert.ok(childId, answer)
    const call = await until(
      '未打开子会话的浏览器调用',
      () =>
        client.frames.find(
          (frame) => frame.method === 'item/tool/call' && frame.params?.threadId === childId,
        ),
      Boolean,
      10_000,
    )
    assert.equal(call.params.namespace, 'litch_browser')
    client.answer(call.id, {
      success: true,
      contentItems: [{ type: 'inputText', text: 'M16 桌面已执行' }],
    })
    const result = await managerReply(client, childId, SESSIONS_HEARD, null, call.params.turnId)
    assert.match(result, /M16 桌面已执行/)
    t.diagnostic(`${parent} → ${child}：子会话未打开，桌面执行结果已回到模型`)
  }
})
