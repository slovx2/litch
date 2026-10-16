import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

async function pages(client: ProtocolClient, method: string, params: Record<string, unknown>) {
  let cursor = (params.cursor as string | undefined) ?? null
  const data: any[] = []
  for (let page = 0; page < 30; page++) {
    const result = await client.request(method, { ...params, cursor, limit: 2 })
    data.push(...result.data)
    cursor = result.nextCursor
    if (cursor == null) break
  }
  assert.equal(cursor, null, '分页必须收敛')
  return data
}

test('HISTORY-002：真实工具大输出、全量与摘要视图、双向分页和重启后无模型读取', {
  timeout: 180_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-history-'))
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  const large = 'OUTPUT_BEGIN\n' + '完整工具历史汉字0123456789\n'.repeat(4096) + 'OUTPUT_END'
  const records: Array<{ threadId: string; mode: string; turns: string[] }> = []
  let toolCalls = 0
  try {
    client.onTool = async () => {
      toolCalls++
      await writeFile(join(home, 'large-result.txt'), large)
      return { success: true, contentItems: [{ type: 'inputText', text: large }] }
    }
    for (const mode of ['legacy', 'paginated']) {
      const { thread } = await client.request('thread/start', {
        cwd: home,
        historyMode: mode,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        dynamicTools: [
          {
            type: 'function',
            name: 'history_output',
            description: '历史输出测试',
            inputSchema: { type: 'object', additionalProperties: false },
          },
        ],
      })
      const turns: string[] = []
      for (let index = 0; index < 3; index++) {
        if (index === 0)
          model.enqueue((request) => {
            const tool = request.tools.find((item: any) =>
              item.name.startsWith('mcp__codex_harness_adapter__'),
            )
            assert.ok(tool)
            return [{ type: 'tool_use', id: `toolu_${mode}`, name: tool.name, input: {} }]
          })
        model.enqueue((request) => {
          if (index === 0) assert.match(JSON.stringify(request.messages), /tool_result/)
          return [{ type: 'text', text: `ANSWER_${mode}_${index}` }]
        })
        const { turn } = await client.request('turn/start', {
          threadId: thread.id,
          clientUserMessageId: `${mode}-${index}`,
          input: [{ type: 'text', text: `INPUT_${mode}_${index}` }],
        })
        assert.equal((await client.completed(turn.id)).status, 'completed')
        turns.push(turn.id)
      }
      records.push({ threadId: thread.id, mode, turns })
    }
    assert.equal(toolCalls, 2)
    const completedTools = client.trace.filter(
      (message) =>
        message.method === 'item/completed' && message.params.item.type === 'dynamicToolCall',
    )
    assert.equal(completedTools.length, 2, '每次工具调用只能有一个原始完成事件')
    for (const event of completedTools) {
      assert.equal(event.params.item.tool, 'history_output')
      assert.deepEqual(event.params.item.contentItems, [{ type: 'inputText', text: large }])
    }
    assert.equal(await readFile(join(home, 'large-result.txt'), 'utf8'), large)
    const callsBeforeRead = model.requests.length
    await client.close()
    client = await ProtocolClient.start(home, url)
    for (const { threadId, mode, turns } of records) {
      const metadata = await client.request('thread/read', { threadId, includeTurns: false })
      assert.equal(metadata.thread.historyMode, mode)
      assert.deepEqual(metadata.thread.turns, [])
      const full = (await client.request('thread/read', { threadId, includeTurns: true })).thread
        .turns
      assert.deepEqual(
        full.map((turn: any) => turn.id),
        turns,
      )
      assert.ok(
        JSON.stringify(full).includes(JSON.stringify(large).slice(1, -1)),
        '完整历史必须保留大工具输出',
      )
      for (const itemsView of ['full', 'summary', 'notLoaded']) {
        for (const sortDirection of ['asc', 'desc']) {
          const listed = await pages(client, 'thread/turns/list', {
            threadId,
            itemsView,
            sortDirection,
          })
          assert.deepEqual(
            listed.map((turn) => turn.id),
            sortDirection === 'asc' ? turns : [...turns].reverse(),
          )
          for (const turn of listed) {
            assert.equal(turn.itemsView, itemsView)
            if (itemsView === 'notLoaded') assert.deepEqual(turn.items, [])
            if (itemsView === 'summary')
              assert.deepEqual(
                turn.items.map((item: any) => item.type),
                ['userMessage', 'agentMessage'],
              )
            if (itemsView === 'full')
              assert.deepEqual(
                turn,
                full.find((item: any) => item.id === turn.id),
              )
          }
        }
      }
      const expected = full.flatMap((turn: any) =>
        turn.items.map((item: any) => ({ turnId: turn.id, item })),
      )
      const listed = await pages(client, 'thread/items/list', { threadId, sortDirection: 'asc' })
      assert.deepEqual(listed, expected)
      assert.deepEqual(
        await pages(client, 'thread/items/list', { threadId, sortDirection: 'desc' }),
        [...expected].reverse(),
      )
      for (const turnId of turns) {
        assert.deepEqual(
          await pages(client, 'thread/items/list', { threadId, turnId }),
          expected.filter((entry: any) => entry.turnId === turnId),
        )
      }
      const first = await client.request('thread/items/list', { threadId, limit: 2 })
      const next = await client.request('thread/items/list', {
        threadId,
        limit: 2,
        cursor: first.nextCursor,
      })
      const backwards = await client.request('thread/items/list', {
        threadId,
        limit: 2,
        sortDirection: 'desc',
        cursor: next.backwardsCursor,
      })
      assert.deepEqual(backwards.data, [next.data[0], first.data[1]])
      const resumed = await client.request('thread/resume', {
        threadId,
        excludeTurns: true,
        initialTurnsPage: { itemsView: 'summary', limit: 2, sortDirection: 'desc' },
      })
      assert.deepEqual(resumed.thread.turns, [])
      assert.deepEqual(
        resumed.initialTurnsPage.data.map((turn: any) => turn.id),
        [...turns].reverse().slice(0, 2),
      )
      // 桌面对 paginated 线程用恢复响应里的头部游标向后拉回合，再逐回合用同一个条目游标取条目。
      const headTurns = await client.request('thread/turns/list', {
        threadId,
        cursor: resumed.turnsBackwardsCursor,
        limit: 5,
        itemsView: 'notLoaded',
        sortDirection: 'desc',
      })
      assert.deepEqual(
        headTurns.data.map((turn: any) => turn.id),
        [...turns].reverse(),
      )
      for (const turnId of turns) {
        assert.deepEqual(
          await pages(client, 'thread/items/list', {
            threadId,
            turnId,
            sortDirection: 'desc',
            cursor: resumed.itemsBackwardsCursor,
          }),
          expected.filter((entry: any) => entry.turnId === turnId).reverse(),
        )
      }
    }
    assert.equal(model.requests.length, callsBeforeRead, '恢复和所有历史视图不能发起模型请求')
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
