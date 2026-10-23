import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { projectNativeHistory } from '../src/native-history.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { signatureOf } from './fixtures/narration-signature.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 旁白：装在 thinking 块里、签名标了 narration 的说明文字。经真的 CLI（它按签名在那一帧上标 narration_block_indexes），
// 画成说明（agentMessage，过程中的话），不画成思考；签名是 thinking 的照旧是思考。顺序跟模型给的一样，
// 后面的回答是单独一条，重读历史也一样。
test('NARRATION-001：签名标了旁白的思考块画成说明文字，真思考照旧，顺序和重读都对', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-narration-'))
  const model = new MockLLM()
  const url = await model.start()
  const client = await ProtocolClient.start(home, url)
  try {
    const { thread } = await client.request('thread/start', { cwd: home })
    model.enqueue(() => [
      { type: 'thinking', thinking: 'MOCK_REAL_THOUGHT', signature: signatureOf('thinking') },
      { type: 'thinking', thinking: 'MOCK_NARRATION', signature: signatureOf('narration') },
      { type: 'text', text: 'MOCK_FINAL' },
    ])
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '校验旁白' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const events = client.trace.filter((event) => event.params?.turnId === turn.id)
    const reasoning = events
      .filter((event) => event.method === 'item/reasoning/summaryTextDelta')
      .map((event) => event.params.delta)
      .join('')
    assert.equal(reasoning, 'MOCK_REAL_THOUGHT')
    const said = events.filter((event) => event.method === 'item/agentMessage/delta')
    assert.deepEqual(
      said.map((event) => event.params.delta),
      ['MOCK_NARRATION', 'MOCK_FINAL'],
    )
    assert.notEqual(said[0].params.itemId, said[1].params.itemId, '旁白和回答是两条')
    const expected = [
      ['reasoning', 'MOCK_REAL_THOUGHT', undefined],
      ['agentMessage', 'MOCK_NARRATION', 'commentary'],
      ['agentMessage', 'MOCK_FINAL', 'final_answer'],
    ]
    const shape = (items: any[]) =>
      items
        .filter((item) => item.type === 'reasoning' || item.type === 'agentMessage')
        .map((item) => [item.type, item.text ?? item.summary.join(''), item.phase])
    const completed = events
      .filter((event) => event.method === 'item/completed')
      .map((event) => event.params.item)
    assert.deepEqual(shape(completed), expected)
    const read = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    assert.deepEqual(shape(read.thread.turns[0].items), expected)
    assert.deepEqual(model.unexpected, [])
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})

// 读原生记录（jsonl 里没有 narration_block_indexes，只能解签名）：旁白是过程中的话，不顶掉最终回答
test('NARRATION-002：读原生记录时旁白画成过程中的说明，不算最终回答', () => {
  const at = (n: number) =>
    new Date(Date.parse('2026-10-23T10:00:00.000Z') + n * 1000).toISOString()
  const message = (type: 'user' | 'assistant', uuid: string, content: unknown, n: number) => ({
    type,
    uuid,
    message: { role: type, content },
    timestamp: at(n),
  })
  const narration = (text: string) => ({
    type: 'thinking',
    thinking: text,
    signature: signatureOf('narration'),
  })
  const history = projectNativeHistory(
    't1',
    [
      message('user', 'u1', '看看构建', 0),
      message(
        'assistant',
        'a1',
        [
          { type: 'thinking', thinking: '', signature: signatureOf('thinking') },
          narration('先跑一遍构建'),
          { type: 'tool_use', id: 'k1', name: 'Bash', input: { command: 'npm run build' } },
        ],
        1,
      ),
      message('user', 'r1', [{ type: 'tool_result', tool_use_id: 'k1', content: 'ok' }], 2),
      message(
        'assistant',
        'a2',
        [
          { type: 'thinking', thinking: '想一想', signature: 'x' },
          { type: 'text', text: '构建通过了' },
          narration('收尾的旁白'),
        ],
        3,
      ),
    ],
    '/work',
  )
  const items = history.turns[0]?.items ?? []
  assert.deepEqual(
    items.map((item: any) => [item.type, item.text ?? item.summary?.join('') ?? null, item.phase]),
    [
      ['userMessage', null, undefined],
      ['agentMessage', '先跑一遍构建', 'commentary'],
      ['commandExecution', null, undefined],
      ['reasoning', '想一想', undefined],
      ['agentMessage', '构建通过了', 'final_answer'],
      ['agentMessage', '收尾的旁白', 'commentary'],
    ],
  )
})
