// “下一步在谁”接到真实设备上：列表过滤、经理显式标记与失效、按声明裁剪、用户改正文送达经理。
// 规则本身在 manager-issue-waiting.test.mts 逐条测。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { MANAGER_ISSUE_METHOD as M, type ManagerIssue } from '../../protocol/src/manager-issues.mjs'
import { treeRig, until } from './tree-kit.mjs'

async function setup() {
  const env = treeRig()
  const client = env.connect()
  await client.initialize([
    'harness',
    'litchManager',
    'litchManagerIssues',
    'litchManagerIssueDiscussions',
    'litchManagerIssueWaiting',
  ])
  const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
    cwd: env.stateDir,
    harness: 'pi',
    model: null,
    effort: null,
    name: '下一步经理',
    scope: '',
    rules: '',
    template: 'blank',
    firstTask: '',
    dispatch: MANAGER_DEFAULT_DISPATCH,
    contact: MANAGER_DEFAULT_CONTACT,
  })
  await until(() => env.pi.running(threadId), '经理启动')
  // 经理回合结束：后面经理的动作不算“本回合在处理”
  env.pi.end(threadId, 'completed', '完成')
  await until(() => !env.device.sessionTree.isActive(threadId), '经理闲置')
  return { env, client, managerId: manager.id as string, threadId: threadId as string }
}

test('经理回复后待处理，显式标记改判进行中，用户一动标记失效；列表按 waiting 过滤', async () => {
  const { env, client, managerId, threadId } = await setup()
  try {
    const issues = env.device.managers.issues
    const asManager = (method: string, params: Record<string, unknown>) =>
      (issues.call(method, { managerId, ...params }, 'manager') as { issue: ManagerIssue }).issue
    let issue = asManager(M.create, { title: '经理开的', body: '看一下' })
    assert.deepEqual(
      { on: issue.waiting?.on, why: issue.waiting?.why },
      { on: 'user', why: 'manager' },
    )
    const ids = async (waiting: string[]) =>
      (
        await client.call(M.list, { managerId, kinds: ['ordinary'], waiting, order: 'newest' })
      ).page.entries.map((one: { id: string }) => one.id)
    assert.deepEqual(await ids(['user']), [issue.id])
    assert.deepEqual(await ids(['agent']), [])
    const head = (await client.call(M.list, { managerId, kinds: ['ordinary'], order: 'newest' }))
      .page.entries[0]
    assert.equal(head.waiting.on, 'user', '列表头带 waiting')

    issue = asManager(M.update, {
      id: issue.id,
      revision: issue.revision,
      patch: { waitingOn: 'agent' },
      why: '派线前先标出来',
    })
    assert.deepEqual(
      { on: issue.waiting?.on, why: issue.waiting?.why },
      { on: 'agent', why: 'marked' },
    )
    assert.deepEqual(await ids(['agent']), [issue.id])

    // 用户评论：标记失效，按“用户最后发言”判进行中，经理被叫醒
    issue = (
      await client.call(M.comment, {
        managerId,
        id: issue.id,
        revision: issue.revision,
        body: '补充一点',
      })
    ).issue
    assert.equal(issue.waiting?.why, 'user')
    await until(() => env.pi.running(threadId), '用户评论叫醒经理')

    // 用户不能设标记
    assert.equal(
      (
        await client.fails(M.update, {
          managerId,
          id: issue.id,
          revision: issue.revision,
          patch: { waitingOn: 'user' },
          why: '用户',
        })
      ).data.litch,
      'issueForbidden',
    )
    // 结束后没有“下一步”，也不在待处理、进行中里
    issue = (
      await client.call(M.update, {
        managerId,
        id: issue.id,
        revision: issue.revision,
        patch: { status: 'resolved' },
        why: '解决了',
      })
    ).issue
    assert.equal(issue.waiting, undefined)
    assert.deepEqual(await ids(['user', 'agent']), [])

    // 没声明的连接：不回传 waiting，不接受新字段
    const old = env.connect()
    await old.initialize(['harness', 'litchManagerIssues', 'litchManagerIssueDiscussions'])
    const open = asManager(M.create, { title: '旧连接', body: '' })
    assert.equal('waiting' in (await old.call(M.read, { managerId, id: open.id })).issue, false)
    const page = (await old.call(M.list, { managerId, order: 'newest' })).page
    assert.equal(
      page.entries.some((one: object) => 'waiting' in one),
      false,
    )
    assert.equal(
      (await old.fails(M.list, { managerId, order: 'newest', waiting: ['user'] })).data.litch,
      'extensionRequired',
    )
  } finally {
    await env.close()
  }
})

test('用户改正文、跟进开着时叫醒经理；只改状态不算发言', async () => {
  const { env, client, managerId, threadId } = await setup()
  try {
    let issue = (
      await client.call(M.create, { managerId, title: '先不跟进', body: '', followUp: 'off' })
    ).issue
    assert.equal(issue.waiting?.why, 'paused')
    issue = (
      await client.call(M.follow, {
        managerId,
        id: issue.id,
        revision: issue.revision,
        state: 'on',
      })
    ).issue
    // 开跟进本身不叫醒；用户最后的发言仍是新建，判进行中
    assert.equal(issue.waiting?.why, 'user')
    assert.equal(env.pi.running(threadId), false)
    issue = (
      await client.call(M.update, {
        managerId,
        id: issue.id,
        revision: issue.revision,
        patch: { body: '补上正文' },
        why: '补正文',
      })
    ).issue
    await until(() => env.pi.running(threadId), '用户改正文叫醒经理')
  } finally {
    await env.close()
  }
})

test('经理本回合处理的 X-n 判进行中；回合结束时推一次变化，改判待处理', async () => {
  const env = treeRig()
  const client = env.connect()
  await client.initialize([
    'harness',
    'litchManager',
    'litchManagerIssues',
    'litchManagerIssueDiscussions',
    'litchManagerIssueWaiting',
  ])
  try {
    const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
      cwd: env.stateDir,
      harness: 'pi',
      model: null,
      effort: null,
      name: '回合经理',
      scope: '',
      rules: '',
      template: 'blank',
      firstTask: '',
      dispatch: MANAGER_DEFAULT_DISPATCH,
      contact: MANAGER_DEFAULT_CONTACT,
    })
    await until(() => env.pi.running(threadId), '经理启动')
    const managerId = manager.id as string
    const issue = (
      env.device.managers.issues.call(
        M.create,
        { managerId, title: '回合里开的', body: '' },
        'manager',
      ) as { issue: ManagerIssue }
    ).issue
    assert.equal(issue.waiting?.why, 'turn')
    // 先读一次，记下当前判定；回合结束后只对变了的推送
    env.device.managers.issues.waitingChanged(managerId)
    const before = client.notifications.length
    env.pi.end(threadId, 'completed', '完成')
    await until(
      () =>
        client.notifications
          .slice(before)
          .some(
            (n) =>
              n.method === 'litch/manager/issue/changed' &&
              (n.params as { issueId: string }).issueId === issue.id,
          ),
      '回合结束推送变化',
    )
    const after = (await client.call(M.read, { managerId, id: issue.id })).issue
    assert.equal(after.waiting?.why, 'manager')
    assert.equal(after.revision, issue.revision, '派生变化不改版本')
  } finally {
    await env.close()
  }
})
