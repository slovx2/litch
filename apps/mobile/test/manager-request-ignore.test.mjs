import assert from 'node:assert/strict'
import test from 'node:test'
import { managerBoardPages, managerRequestStatus, submitManagerRequest } from '@litch/core'
import {
  managerObjectLocation,
  managerPageStates,
} from '../../../packages/core/src/projection/manager-paging.mts'
import { issuePending } from '../src/screens/managers/presentation.ts'
import { mockChannel, until } from './helpers.mjs'

test('手机忽略请你做：空理由/有理由均结束待处理，编号定位进入独立忽略分栏', async () => {
  for (const text of ['', '这事不用管了']) {
    const mock = mockChannel()
    let board
    const stop = mock.channel.subscribe(
      { kind: 'managerBoard', deviceId: 'local', managerId: 'm1' },
      {
        snapshot: (view) => {
          board = view.board
        },
        delta: (ops) => {
          for (const op of ops) if (op.op === 'managerBoard.set') board = op.view.board
        },
        error: (error) => {
          throw error
        },
      },
    )
    try {
      const request = await until(() => board?.requests?.find((r) => r.id === 'R-1'))
      assert.equal(issuePending({ id: request.id, kind: 'request' }, board, []), true)
      const accepted = await submitManagerRequest(mock.channel, 'local', 'm1', {
        requestId: request.id,
        revision: request.revision,
        delivered: false,
        ignored: true,
        text,
      })
      assert.equal(managerRequestStatus(accepted), 'ignored')
      assert.equal(accepted.response.text, text)
      await until(() => board?.requests?.find((r) => r.id === 'R-1')?.response?.ignored)
      assert.equal(issuePending({ id: request.id, kind: 'request' }, board, []), false)
      assert.deepEqual(managerObjectLocation(board, request.id), {
        kind: 'request',
        status: 'ignored',
      })
      assert.ok(managerPageStates.request.includes('ignored'))
      assert.ok(!managerBoardPages(board).overview.requests.some((r) => r.id === request.id))
    } finally {
      stop()
      mock.close()
    }
  }
})
