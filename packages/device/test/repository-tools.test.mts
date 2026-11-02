import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ClientToolCallResponse } from '../../protocol/src/client-tools.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { treeRig, until } from './tree-kit.mjs'
import { commitAll, makeRepo, sh, write } from './worktree-kit.mjs'

test('Git 工具：经理/临时身份、工作线工作树、分页所有权、并发及退役闸', async () => {
  const env = treeRig()
  const outside = mkdtempSync(join(tmpdir(), 'other-repo-'))
  try {
    env.pi.declaration = {
      extensions: ['clientTools'],
      features: { ephemeralFork: true, managerQuestions: true },
    }
    const client = env.connect()
    await client.initialize(['harness', 'litchManager'])
    const repo = makeRepo(env.stateDir)
    write(repo, 'pages.txt', 'line text\n'.repeat(5000))
    commitAll(repo, 'long file')
    const lineDirectory = join(outside, 'line')
    sh(repo, 'worktree', 'add', '-q', '-b', 'line', lineDirectory)
    const unrelated = makeRepo(outside, 'unrelated')
    const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
      cwd: env.stateDir,
      harness: 'pi',
      model: null,
      effort: null,
      name: '查询',
      scope: '',
      rules: '',
      template: 'blank',
      firstTask: '',
      dispatch: MANAGER_DEFAULT_DISPATCH,
      contact: MANAGER_DEFAULT_CONTACT,
    })
    await until(() => env.pi.running(threadId), '经理开始')
    env.pi.end(threadId, 'completed', '已就绪')
    const line = (await client.call('thread/start', { harness: 'claude-code', cwd: lineDirectory }))
      .thread.id
    env.device.sessionTree.store.addLineage({
      threadId: line,
      parentThreadId: threadId,
      harness: 'claude-code',
      kind: 'fresh',
      origin: 'model',
      title: '工作线',
      prompt: '',
      wakeParent: false,
      createdAt: 1,
      proposalId: '',
    })
    env.device.managers.writer.tool(manager.id, 'add', {
      kind: 'decision',
      decision: { title: '查询背景', background: '' },
    })
    await client.call(MANAGER_METHOD.questionAsk, {
      managerId: manager.id,
      decisionId: 'D-1',
      revision: 1,
      question: '查 git',
    })
    await until(() => !!env.device.managers.store.question(manager.id, 'D-1')?.threadId, '旁问开始')
    const temporary = env.device.managers.store.question(manager.id, 'D-1')?.threadId
    assert.ok(temporary)
    const call = (tool: string, args: unknown, caller = temporary) =>
      new Promise<ClientToolCallResponse>((resolve) => {
        env.device.deviceTools.dispatch(
          'pi',
          {
            namespace: 'litch_repository',
            tool,
            arguments: args,
            threadId: caller,
            turnId: 'probe',
            callId: randomUUID(),
          },
          (response) => {
            resolve(response)
            return true
          },
        )
      })
    const value = (result: ClientToolCallResponse) => {
      assert.equal(result.success, true, JSON.stringify(result))
      const first = result.contentItems[0]
      assert.ok(first && 'text' in first)
      return JSON.parse(first.text)
    }
    assert.equal(value(await call('status', { directory: lineDirectory })).content, '')
    assert.equal(value(await call('status', { directory: repo }, threadId)).content, '')
    assert.equal((await call('status', { directory: repo }, line)).success, false)
    assert.equal((await call('status', { directory: unrelated })).success, false)
    symlinkSync(unrelated, join(env.stateDir, 'escape'))
    assert.equal((await call('status', { directory: join(env.stateDir, 'escape') })).success, false)
    assert.equal((await call('commit', { directory: repo })).success, false)
    const initial = value(await call('show', { directory: repo, path: 'pages.txt' }))
    assert.ok(initial.next_cursor)
    assert.ok(initial.content.length <= 12000)
    assert.equal((await call('show', { cursor: initial.next_cursor }, threadId)).success, false)
    assert.equal((await call('log', { cursor: initial.next_cursor })).success, false)
    let content = initial.content
    let cursor = initial.next_cursor
    while (cursor) {
      const page = value(await call('show', { cursor }))
      assert.equal(page.captured_at, initial.captured_at)
      content += page.content
      cursor = page.next_cursor
    }
    assert.equal(content, 'line text\n'.repeat(5000))
    const parallel = await Promise.all([
      call('log', { directory: repo }),
      call('log', { directory: repo }),
      call('log', { directory: repo }),
    ])
    assert.equal(parallel.filter((result) => result.success).length, 2)
    const state = env.device.managers.store.question(manager.id, 'D-1')
    assert.ok(state)
    await env.device.managers.questions.release(state, await env.device.sessionTree.link('pi'))
    assert.equal((await call('status', { directory: repo })).success, false)
  } finally {
    await env.close()
    rmSync(outside, { recursive: true, force: true })
  }
})
