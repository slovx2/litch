import assert from 'node:assert/strict'
import test from 'node:test'
import type { CoreChannel } from '../src/channel/client.mjs'
import { submitManagerRequest } from '../src/submit-manager-request.mjs'

test('单卡响应直接提交完成或文字，不连带提交其他卡片、决策和追问', async () => {
  for (const delivered of [true, false]) {
    let captured: unknown
    const channel = {
      command: async (name: string, params: unknown) => {
        assert.equal(name, 'managers.feedback.submit')
        captured = params
        return { acceptedRequests: [{ id: 'R-1' }], rejectedRequests: [] }
      },
    } as unknown as Pick<CoreChannel, 'command'>
    const request = { requestId: 'R-1' as const, revision: 3, delivered, text: '真机已验证' }
    assert.deepEqual(await submitManagerRequest(channel, 'device', 'manager', request), {
      id: 'R-1',
    })
    assert.deepEqual(captured, {
      deviceId: 'device',
      managerId: 'manager',
      answers: [],
      questions: [],
      requests: [request],
    })
  }
})

test('冲突和缺失回执不能被当成成功清理草稿', async () => {
  const request = { requestId: 'R-1' as const, revision: 3, delivered: true, text: '保留备注' }
  const channel = {
    command: async () => ({
      acceptedRequests: [],
      rejectedRequests: [{ requestId: 'R-1', message: '版本冲突' }],
    }),
  } as unknown as Pick<CoreChannel, 'command'>
  await assert.rejects(submitManagerRequest(channel, 'd', 'm', request), /版本冲突/)
  const missing = {
    command: async () => ({ acceptedRequests: [], rejectedRequests: [] }),
  } as unknown as Pick<CoreChannel, 'command'>
  assert.equal(await submitManagerRequest(missing, 'd', 'm', request), null)
  assert.equal(request.text, '保留备注')
})

test('忽略单卡带显式 ignored，空理由仍有效，不夹带交付或其他草稿', async () => {
  const request = {
    requestId: 'R-2' as const,
    revision: 1,
    delivered: false,
    ignored: true,
    text: '',
  }
  const channel = {
    command: async (_: unknown, params: any) => {
      assert.deepEqual(params.requests, [request])
      assert.deepEqual(params.answers, [])
      assert.deepEqual(params.questions, [])
      return {
        acceptedRequests: [{ id: 'R-2', response: { ignored: true } }],
        rejectedRequests: [],
      }
    },
  } as unknown as Pick<CoreChannel, 'command'>
  assert.equal(
    (await submitManagerRequest(channel, 'device', 'manager', request))?.response?.ignored,
    true,
  )
})
