// 真实 CLI，白名单环境、隔离 HOME 和设备库、回环假模型；夹具结束删除所有记录。
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { managerBundle } from '../packages/device/dist/device/src/manager-rules.mjs'
import {
  managerClient,
  managerReply,
  startManagerFixture,
  until,
} from './client-fixture-manager-check.mjs'
import { findCodex } from './client-fixture-responses.mjs'

const cleanup = []
const context = { after: (work) => cleanup.push(work) }
try {
  assert.ok(process.env.CHA_CLAUDE_CLI, '必须给隔离 Claude CLI')
  const fixture = await startManagerFixture(context, {
    CHA_CLAUDE_CLI: process.env.CHA_CLAUDE_CLI,
    CHA_CODEX_CLI: findCodex(),
  })
  const client = await managerClient(context, fixture.socket)
  for (const harness of ['claude-code', 'codex']) {
    const { manager, threadId } = await client.call('litch/manager/create', {
      cwd: fixture.engines.cwd,
      harness,
      model: null,
      effort: null,
      name: `reset-${harness}`,
      scope: '验证经理会话重置',
      rules: 'RESET_CURRENT_RULE',
      template: 'blank',
      firstTask: '',
      permission: ':read-only',
      dispatch: {
        harness: null,
        model: null,
        effort: null,
        worktree: false,
        merge: 'manager',
        maxRunningLines: 4,
      },
      contact: { desktopNotification: true, unanswered: 'wait' },
    })
    await managerReply(client, threadId, '经理已就绪', 'manager-open')
    const before = (await client.call('thread/read', { threadId, includeTurns: true })).thread
    if (harness === 'claude-code') {
      const tools = managerBundle(manager, false).map((space) => ({
        ...space,
        instructions: 'RESET_OLD_RULE',
        tools: space.tools.filter((tool) => tool.name !== 'reply'),
      }))
      await client.call('thread/resume', { threadId, dynamicTools: tools })
      const old = await client.call('turn/start', {
        threadId,
        input: [{ type: 'text', text: '记录旧版本探针', text_elements: [] }],
      })
      await until(
        '旧版本请求结束',
        () => client.call('thread/read', { threadId, includeTurns: true }),
        ({ thread }) =>
          thread.turns.some((turn) => turn.id === old.turn.id && turn.status === 'completed'),
      )
    }
    await client.call('litch/manager/reset', { managerId: manager.id })
    const result = await until(
      '重置完成',
      () => client.call('litch/manager/list', {}),
      ({ managers }) => {
        const now = managers.find((one) => one.id === manager.id)
        assert.ok(!['failed', 'summaryFailed'].includes(now.reset.phase), JSON.stringify(now.reset))
        return now.reset.phase === 'ready'
      },
    )
    const current = result.managers.find((one) => one.id === manager.id)
    assert.equal(current.reset.outdated, false)
    if (harness === 'claude-code') {
      assert.equal(current.threadId, threadId)
      const after = (await client.call('thread/read', { threadId, includeTurns: true })).thread
      assert.deepEqual(after.turns[0], before.turns[0])
      const next = await client.call('turn/start', {
        threadId,
        input: [{ type: 'text', text: '经理：summary {}', text_elements: [] }],
      })
      await managerReply(client, threadId, '经理结果：', null, next.turn.id)
      const bodies = readdirSync(fixture.modelDump).map(
        (file) => JSON.parse(readFileSync(join(fixture.modelDump, file), 'utf8')).request,
      )
      assert.ok(bodies.some((body) => JSON.stringify(body.system).includes('RESET_OLD_RULE')))
      const latest = bodies
        .filter((body) => JSON.stringify(body.system).includes('RESET_CURRENT_RULE'))
        .at(-1)
      assert.ok(latest, '刷新后的真实模型请求含新指令')
      assert.ok(
        latest.tools.some((tool) =>
          tool.description?.includes('Reply to pending user follow-up questions'),
        ),
        `刷新后恢复新版 reply 工具：${latest.tools.map((tool) => `${tool.name}: ${tool.description?.slice(0, 100)}`).join(' | ')}`,
      )
      console.log('PASS Claude 原地刷新：同线程、原历史、新工具和新指令已到达真实 CLI 模型请求')
    } else {
      assert.notEqual(current.threadId, threadId)
      await until(
        '新经理接班',
        () => client.call('thread/read', { threadId: current.threadId, includeTurns: true }),
        ({ thread }) =>
          thread.turns.some(
            (turn) => turn.status === 'completed' && JSON.stringify(turn).includes('已接手经理'),
          ),
      )
      await assert.rejects(client.call('turn/start', { threadId, input: [] }), /read-only/)
      const old = (await client.call('thread/read', { threadId, includeTurns: true })).thread
      assert.ok(JSON.stringify(old).includes('交接摘要：'))
      const next = await client.call('turn/start', {
        threadId: current.threadId,
        input: [{ type: 'text', text: '经理：summary {}', text_elements: [] }],
      })
      await managerReply(client, current.threadId, '经理结果：', null, next.turn.id)
      console.log('PASS 原生 Codex 换线程：旧线程生成摘要、新线程接班并读取看板、旧线程只读')
    }
  }
} finally {
  for (const work of cleanup.reverse()) await work()
}
