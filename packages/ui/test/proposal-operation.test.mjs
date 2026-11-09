import assert from 'node:assert/strict'
import test from 'node:test'
import { proposalOperation, withProposalNote } from '../src/tree/proposal-operation.ts'

function fixture() {
  const requests = []
  const channel = {
    command(name, params) {
      return new Promise((resolve, reject) => requests.push({ name, params, resolve, reject }))
    },
  }
  return {
    channel,
    requests,
    operation: proposalOperation(channel, 'remote', 'parent', 'proposal'),
  }
}

test('补充说明追加在任务后；空白不产生覆盖，不修改原卡片或编辑参数', () => {
  const proposal = Object.freeze({ prompt: '原任务', background: '原背景' })
  const overrides = Object.freeze({ prompt: '改过的任务', worktree: true })
  assert.deepEqual(withProposalNote(proposal.prompt, '  \n '), {})
  assert.deepEqual(withProposalNote(proposal.prompt, '补一条\n再一条', overrides), {
    prompt: '改过的任务\n\n用户补充说明：\n补一条\n再一条',
    worktree: true,
  })
  assert.equal(proposal.prompt, '原任务')
  assert.equal(overrides.prompt, '改过的任务')
})

test('请求未回包时同步显示正在开始；关闭编辑器、切页仍保留状态且重复点击只发送一次', async () => {
  const { channel, requests, operation } = fixture()
  const changes = []
  const unsubscribe = operation.subscribe(() => changes.push(operation.snapshot()))
  const first = operation.start({ prompt: '原任务\n\n用户补充说明：\n补一条' })
  assert.equal(operation.snapshot().busy, true)
  assert.equal(operation.start({ prompt: '第二次点击' }), first)
  unsubscribe()
  await Promise.resolve()
  assert.equal(requests.length, 1)
  const reopened = proposalOperation(channel, 'remote', 'parent', 'proposal')
  assert.equal(reopened.snapshot().busy, true)
  assert.equal(proposalOperation(channel, 'other', 'parent', 'proposal').snapshot().busy, false)
  requests[0].resolve({ sessionId: 'child' })
  assert.deepEqual(await first, { sessionId: 'child' })
  assert.equal(reopened.snapshot().busy, false)
  assert.equal(changes.length, 1)
})

test('晚到的失败留在卡片；重试带原编辑值和补充说明，成功后清错误', async () => {
  const { channel, requests, operation } = fixture()
  const overrides = { prompt: '任务\n\n用户补充说明：\n检查远程', harness: 'codex', worktree: true }
  const first = operation.start(overrides)
  overrides.prompt = '调用方后来改了草稿'
  await Promise.resolve()
  requests[0].reject(new Error('远程设备拒绝开始'))
  assert.equal(await first, undefined)
  const reopened = proposalOperation(channel, 'remote', 'parent', 'proposal')
  assert.match(reopened.snapshot().error.message, /远程设备拒绝/)
  const retry = reopened.retry()
  await Promise.resolve()
  assert.deepEqual(requests[1].params, requests[0].params)
  requests[1].resolve({ sessionId: 'child' })
  await retry
  assert.deepEqual(reopened.snapshot(), { busy: false, error: null })
})

test('同步抛出的通道错误同样保留并解除 busy', async () => {
  const operation = proposalOperation(
    {
      command() {
        throw new Error('离线')
      },
    },
    'd',
    's',
    'p',
  )
  await operation.start()
  assert.equal(operation.snapshot().busy, false)
  assert.equal(operation.snapshot().error.message, '离线')
})
