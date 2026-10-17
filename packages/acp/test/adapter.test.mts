import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { dispose, scene, text, turn, violations } from './client.mjs'

// 主流程：对着假 ACP agent（fake-agent.mts）走一遍会话、回合、审批、改文件、终端、设置。往来消息都按协议 schema 校验。

test('新建会话、说一句话：话流、思考、计划、用量都转成 Codex 的通知', async () => {
  const s = await scene()
  try {
    const started = await s.desktop.call('thread/start', { cwd: s.cwd })
    const id = started.thread.id
    assert.equal(started.model, 'fake-small')
    assert.equal(started.reasoningEffort, 'low')
    assert.equal(started.modelProvider, 'acp')
    await s.desktop.until('thread/started', (p) => p.thread.id === id)
    const done = await turn(s, id, text('hello'))
    assert.equal(done.status, 'completed')
    const types = done.items.map((item: any) => item.type)
    assert.deepEqual(types, ['userMessage', 'reasoning', 'agentMessage'])
    const message = done.items.find((item: any) => item.type === 'agentMessage')
    assert.equal(message.text, '你好，世界')
    assert.equal(message.phase, 'final_answer')
    const deltas = s.desktop.notifications
      .filter((n) => n.method === 'item/agentMessage/delta')
      .map((n) => n.params.delta)
    assert.deepEqual(deltas, ['你好', '，世界'])
    const plan = await s.desktop.until('turn/plan/updated')
    assert.deepEqual(
      plan.plan.map((step: any) => step.status),
      ['completed', 'inProgress'],
    )
    const usage = s.desktop.notifications.filter((n) => n.method === 'thread/tokenUsage/updated')
    assert.ok(usage.length >= 1)
    assert.equal(usage.at(-1).params.tokenUsage.modelContextWindow, 200000)
    assert.equal(usage.at(-1).params.tokenUsage.total.totalTokens, 1500)
    // 说过话的会话进列表，重读拿得到历史
    const listed = await s.desktop.call('thread/list', {})
    assert.ok(listed.data.some((thread: any) => thread.id === id))
    const read = await s.desktop.call('thread/read', { threadId: id })
    assert.equal(read.thread.turns.length, 1)
    assert.equal(read.thread.preview, 'hello')
    assert.deepEqual([...violations], [])
  } finally {
    await dispose(s)
  }
})

test('命令审批：同意后在终端里跑，输出一段段转给客户端；拒绝的条目记成 declined', async () => {
  const s = await scene()
  try {
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    s.desktop.onRequest(() => ({ decision: 'accept' }))
    const ran = await turn(s, thread.id, text('run'))
    const command = ran.items.find((item: any) => item.type === 'commandExecution')
    assert.equal(command.status, 'completed')
    assert.equal(command.command, 'echo hi')
    assert.equal(command.exitCode, 0)
    assert.match(command.aggregatedOutput, /hi/)
    const approval = s.desktop.requests.find(
      (r) => r.method === 'item/commandExecution/requestApproval',
    )
    assert.deepEqual(approval.params.availableDecisions, [
      'accept',
      'acceptForSession',
      'decline',
      'cancel',
    ])
    assert.ok(
      s.desktop.notifications.some(
        (n) => n.method === 'item/commandExecution/outputDelta' && n.params.delta.includes('hi'),
      ),
    )
    const answers = (await s.received()).filter((m) => m.id !== undefined && m.result?.outcome)
    assert.deepEqual(answers.at(-1).result, { outcome: { outcome: 'selected', optionId: 'once' } })

    s.desktop.onRequest(() => ({ decision: 'decline' }))
    const refused = await turn(s, thread.id, text('run'))
    const declined = refused.items.find((item: any) => item.type === 'commandExecution')
    assert.equal(declined.status, 'declined')
    const last = (await s.received()).filter((m) => m.result?.outcome).at(-1)
    assert.deepEqual(last.result, { outcome: { outcome: 'selected', optionId: 'reject' } })
    assert.deepEqual([...violations], [])
  } finally {
    await dispose(s)
  }
})

test('一整份一整份推的命令输出换成增量', async () => {
  const s = await scene()
  try {
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    const done = await turn(s, thread.id, text('snapshot'))
    const command = done.items.find((item: any) => item.type === 'commandExecution')
    assert.equal(command.aggregatedOutput, 'a\nb\n')
    const deltas = s.desktop.notifications
      .filter((n) => n.method === 'item/commandExecution/outputDelta')
      .map((n) => n.params.delta)
    assert.deepEqual(deltas, ['a\n', 'b\n'])
  } finally {
    await dispose(s)
  }
})

test('改文件：审批走 fileChange，agent 经 fs/write_text_file 写的内容出成带差异的条目', async () => {
  const s = await scene()
  try {
    const path = join(s.cwd, 'note.txt')
    await writeFile(path, 'first\n')
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    s.desktop.onRequest(() => ({ decision: 'accept' }))
    const done = await turn(s, thread.id, text(`edit ${path}`))
    assert.ok(s.desktop.requests.some((r) => r.method === 'item/fileChange/requestApproval'))
    const change = done.items.find((item: any) => item.type === 'fileChange')
    assert.equal(change.status, 'completed')
    assert.equal(change.changes[0].path, path)
    assert.equal(change.changes[0].kind.type, 'update')
    assert.match(change.changes[0].diff, /\+added/)
    assert.equal(await readFile(path, 'utf8'), 'first\nadded\n')
    // 新建的文件
    const fresh = join(s.cwd, 'sub', 'new.txt')
    const created = await turn(s, thread.id, text(`edit ${fresh}`))
    const add = created.items.find((item: any) => item.type === 'fileChange')
    assert.equal(add.changes[0].kind.type, 'add')
    assert.equal(await readFile(fresh, 'utf8'), 'added\n')
    // 读文件按行取
    const read = await turn(s, thread.id, text(`read ${path}`))
    assert.equal(read.items.at(-1).text, '第二行是 added')
    assert.deepEqual([...violations], [])
  } finally {
    await dispose(s)
  }
})
