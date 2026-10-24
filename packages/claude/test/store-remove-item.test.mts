// 从回合里撤掉一个条目（store.mts 的 removeItem）：模型请求重试时，失败那次流出来的半截回答作废。
// 和别的条目改动一样只记一笔，读回来、重新打开库都没有它
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionStore } from '../src/store.mjs'

test('STORE-REMOVE-001：撤掉的条目读不到，流式记着的字也不会补回来', async () => {
  const home = await mkdtemp(join(tmpdir(), 'store-remove-item-'))
  const path = join(home, 'state.sqlite')
  const threadId = randomUUID()
  const turnId = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  let store = new SessionStore(path)
  try {
    store.upsertThread({
      id: threadId,
      sessionId: threadId,
      forkedFromId: null,
      preview: '撤掉条目',
      name: null,
      archived: false,
      cwd: home,
      model: 'sonnet',
      reasoningEffort: null,
      modelProvider: 'claude-code',
      claudeSessionId: null,
      source: 'appServer',
      createdAt: now,
      updatedAt: now,
      status: { type: 'active', activeFlags: [] },
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      ephemeral: false,
      threadSource: 'user',
      agentRole: null,
      agentNickname: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      runtimeBackend: 'claude',
      codexSessionId: null,
    })
    store.upsertTurn({
      id: turnId,
      threadId,
      status: 'inProgress',
      startedAt: now,
      completedAt: null,
      durationMs: null,
      error: null,
      diff: '',
      items: [
        {
          type: 'userMessage',
          id: 'user',
          content: [{ type: 'text', text: '说一段话', text_elements: [] }],
        },
      ],
    })
    const agent = (id: string) =>
      ({ type: 'agentMessage', id, text: '', phase: null, memoryCitation: null }) as const
    store.appendItem(turnId, agent('half'))
    store.appendTextLater(turnId, 'half', '半截回答')
    store.removeItem(turnId, 'half')
    store.appendItem(turnId, agent('full'))
    store.appendTextLater(turnId, 'full', '完整的回答')
    const texts = (s: SessionStore) =>
      s.getTurn(turnId)?.items.map((item) => [item.id, 'text' in item ? item.text : null])
    const expected = [
      ['user', null],
      ['full', '完整的回答'],
    ]
    assert.deepEqual(texts(store), expected)
    // 没撤的条目不受影响；撤掉一个不存在的条目什么也不做
    store.removeItem(turnId, 'missing')
    assert.deepEqual(texts(store), expected)
    store.close()
    store = new SessionStore(path)
    assert.deepEqual(texts(store), expected, '重新打开库')
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true })
  }
})
