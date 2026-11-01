import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { MANAGER_POST_METHOD } from '../../protocol/src/manager-posts.mjs'
import { treeRig, until } from './tree-kit.mjs'

async function setup() {
  const env = treeRig()
  env.pi.declaration = {
    extensions: ['clientTools'],
    features: { ephemeralFork: true, managerQuestions: true },
  }
  const client = env.connect()
  await client.initialize(['harness', 'litchManager', 'sessionTree', 'suggestionInbox'])
  const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
    cwd: env.stateDir,
    harness: 'pi',
    model: null,
    effort: null,
    name: '控制台',
    scope: '',
    rules: '',
    template: 'blank',
    firstTask: '',
    dispatch: MANAGER_DEFAULT_DISPATCH,
    contact: MANAGER_DEFAULT_CONTACT,
  })
  await until(() => env.pi.running(threadId), '经理启动')
  return {
    env,
    client,
    manager,
    threadId,
    posts: env.device.managers.posts,
    writer: env.device.managers.writer,
  }
}
test('报告发布、已阅和更新版本校验；回复可仅改原帖、仅回帖或两者同时，历史与计数保留', async () => {
  const { env, client, manager, posts } = await setup()
  try {
    const created = posts.tool(manager.id, 'report', {
      title: '版本小结',
      body: '## 范围\n- **已完成**',
      why: '阶段汇报',
    }).post
    assert.equal(created.id, 'P-1')
    assert.equal(env.device.managers.manager(manager.id).pendingReports, 1)
    await client.call(MANAGER_POST_METHOD.read, {
      managerId: manager.id,
      id: created.id,
      revision: 1,
    })
    assert.equal(env.device.managers.manager(manager.id).pendingReports, 0)
    await client.call(MANAGER_POST_METHOD.question, {
      managerId: manager.id,
      id: created.id,
      revision: 1,
      question: '限制？',
      mode: 'manager',
    })
    const edited = posts.tool(manager.id, 'post_reply', {
      id: created.id,
      revision: 1,
      patch: { body: '## 限制\n待验证' },
      why: '补范围',
    }).post
    assert.equal(edited.revision, 2)
    assert.equal(edited.unread, true)
    assert.equal(edited.versions[0]?.body, created.body)
    assert.equal(edited.discussion.messages[0]?.updatedPost, true)
    assert.equal(edited.discussion.messages[0]?.status, 'completed')
    assert.match(
      (
        await client.fails(MANAGER_POST_METHOD.read, {
          managerId: manager.id,
          id: created.id,
          revision: 1,
        })
      ).message,
      /changed/,
    )
    assert.throws(
      () =>
        posts.tool(manager.id, 'post_reply', {
          id: created.id,
          revision: 1,
          text: '旧版本',
          why: '回复',
        }),
      /changed/,
    )
    posts.tool(manager.id, 'post_reply', {
      id: created.id,
      revision: 2,
      text: '额外说明',
      why: '补充',
    })
    assert.equal(posts.get(manager.id, created.id).discussion.messages.at(-1)?.answer, '额外说明')
    await client.call(MANAGER_POST_METHOD.question, {
      managerId: manager.id,
      id: created.id,
      revision: 2,
      question: '还有？',
      mode: 'manager',
    })
    const both = posts.tool(manager.id, 'post_reply', {
      id: created.id,
      revision: 2,
      text: '已补充',
      patch: { title: '更新小结' },
      why: '澄清',
    }).post
    assert.equal(both.revision, 3)
    assert.equal(both.discussion.messages.at(-1)?.answer, '已补充')
    assert.equal(both.discussion.messages.at(-1)?.updatedPost, true)
    assert.throws(() =>
      posts.tool(manager.id, 'post_reply', {
        id: created.id,
        revision: 3,
        patch: { readRevision: 3 },
        why: '代读',
      }),
    )
    const plain = env.connect()
    await plain.initialize(['harness'])
    assert.equal(
      (
        await plain.fails(MANAGER_POST_METHOD.read, {
          managerId: manager.id,
          id: created.id,
          revision: 3,
        })
      ).data?.litch,
      'extensionRequired',
    )
  } finally {
    await env.close()
  }
})
test('四类议题共用追问；建议修改原提案、不能越权或修改已经开始的卡', async () => {
  const { env, client, manager, threadId, posts, writer } = await setup()
  try {
    const decision = writer.tool(manager.id, 'add', {
      kind: 'decision',
      decision: { title: '方向', background: '待选' },
    }) as any
    const request = writer.tool(manager.id, 'add', {
      kind: 'request',
      revision: 0,
      why: '真机',
      request: { title: '复验', description: '检查界面' },
    }) as any
    const proposal = env.device.sessionTree.propose({
      threadId,
      title: '代理工作',
      prompt: '检查边界',
      background:
        '隔离测试的提案，背景足够完整，仅在测试目录中执行，避免访问个人配置。任务是核对实现与协议并记录所有未验证的路径。',
      harness: null,
      model: null,
      cwd: null,
      kind: 'fresh',
      wakeParent: true,
      offer: false,
    })
    const ids = [decision.id, request.id, `S-${proposal.id}`]
    for (const id of ids) {
      await client.call(MANAGER_POST_METHOD.question, {
        managerId: manager.id,
        id,
        revision: 1,
        question: '为什么？',
        mode: 'manager',
      })
      const post = posts.tool(manager.id, 'post_reply', {
        id,
        revision: 1,
        patch: { body: '已澄清' },
        text: '解释',
        why: '用户追问',
      }).post
      assert.equal(post.body, '已澄清')
      assert.equal(post.discussion.messages[0]?.answer, '解释')
    }
    assert.equal(env.device.sessionTree.store.proposal(proposal.id)?.prompt, '已澄清')
    assert.equal(env.device.managers.manager(manager.id).pendingSuggestions, 1)
    env.device.sessionTree.settleProposal(proposal.id, 'dismissed', null)
    assert.equal(env.device.managers.manager(manager.id).pendingSuggestions, 0)
    assert.throws(
      () =>
        posts.tool(manager.id, 'post_reply', {
          id: `S-${proposal.id}`,
          revision: 2,
          patch: { title: '不能编辑' },
          why: '已忽略',
        }),
      /pending/,
    )
    assert.throws(() => posts.get('other', `S-${proposal.id}`), /belong/)
    assert.throws(
      () =>
        posts.tool(manager.id, 'post_reply', {
          id: request.id,
          revision: 2,
          patch: { options: [] },
          why: '不允许',
        }),
      /Unknown field/,
    )
  } finally {
    await env.close()
  }
})
test('临时帖子只准更新自己的原帖，报告和请求都留下追问来源，不能发消息或写别的对象', async () => {
  const { env, client, manager, threadId, posts, writer } = await setup()
  try {
    const report = posts.tool(manager.id, 'report', {
      title: '报告',
      body: '原文',
      why: '汇报',
    }).post
    const request = writer.tool(manager.id, 'add', {
      kind: 'request',
      revision: 0,
      why: '真机',
      request: { title: '验证', description: '原文' },
    }) as any
    env.pi.end(threadId, 'completed', '已发布')
    await until(() => !env.device.sessionTree.isActive(threadId), '经理空闲')
    for (const id of [report.id, request.id]) {
      await client.call(MANAGER_POST_METHOD.question, {
        managerId: manager.id,
        id,
        revision: 1,
        question: '补充范围',
        mode: 'temporary',
      })
      await until(() => !!env.device.managers.store.question(manager.id, id)?.threadId, '临时分叉')
      const fork = env.device.managers.store.question(manager.id, id)?.threadId as string
      await until(() => env.pi.running(fork), '临时运行')
      const invoke = (tool: string, args: unknown) =>
        env.pi.callTool(fork, 'litch_manager', tool, args)
      assert.equal(
        (
          await invoke('post_reply', {
            id,
            revision: 1,
            patch: { body: '澄清后的内容' },
            why: '追问修改',
          })
        )?.answer.result.success,
        true,
      )
      assert.equal(
        (
          await invoke('post_reply', {
            id: id === report.id ? request.id : report.id,
            revision: 1,
            patch: { body: '越权' },
            why: '越权',
          })
        )?.answer.result.success,
        false,
      )
      assert.equal(
        (await invoke('post_reply', { id, revision: 2, text: '不能冒充经理回复', why: '越权' }))
          ?.answer.result.success,
        false,
      )
      assert.equal(
        (await invoke('report', { title: '越权', body: '越权', why: '越权' }))?.answer.result
          .success,
        false,
      )
      assert.equal(
        env.device.managers.store
          .changes(manager.id)
          .find((c) => c.objectId === id && c.why === '追问修改')?.by,
        'question',
      )
      env.pi.end(fork, 'completed', '范围已更新')
      await until(
        () =>
          env.device.managers.store.question(manager.id, id)?.discussion.messages.at(-1)?.status ===
          'completed',
        '追问回复',
      )
    }
  } finally {
    await env.close()
  }
})

test('来源和相关关系持久化、跨板拒绝，原字段投影及反向关联共用一条边', async () => {
  const { env, manager, posts, writer } = await setup()
  try {
    const d = writer.tool(manager.id, 'add', {
      kind: 'decision',
      decision: { title: '方案', background: '说明' },
    }) as any
    const item = writer.tool(manager.id, 'add', {
      kind: 'item',
      item: { title: '实现' },
      source: [{ kind: 'issue', target: d.id }],
    }) as any
    const report = posts.tool(manager.id, 'report', {
      title: '说明',
      body: '#D-1',
      why: '报告',
      source: [{ kind: 'item', target: item.id }],
      related: [{ kind: 'issue', target: d.id }],
    }).post
    const relations = env.device.managers.board(manager.id).relations ?? []
    assert.ok(
      relations.some(
        (r) => r.from.target === item.id && r.to.target === d.id && r.kind === 'derived',
      ),
    )
    assert.ok(relations.some((r) => r.from.target === report.id && r.to.target === item.id))
    assert.throws(
      () =>
        posts.tool(manager.id, 'relate', {
          id: d.id,
          related: [{ kind: 'issue', target: 'D-999' }],
          why: '越权',
        }),
      /belong/,
    )
    const count = env.device.managers.store.objects(manager.id).length
    assert.throws(() =>
      writer.tool(manager.id, 'add', {
        kind: 'item',
        item: { title: '不能留下半条' },
        source: [{ kind: 'issue', target: 'D-999' }],
      }),
    )
    assert.equal(env.device.managers.store.objects(manager.id).length, count)
  } finally {
    await env.close()
  }
})

test('关联仓库查看只在经理目录读取已解析提交，选项及不存在的引用拒绝', async () => {
  const { env, client, manager } = await setup()
  try {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: env.stateDir, encoding: 'utf8' })
    git('init')
    writeFileSync(join(env.stateDir, 'example.txt'), 'evidence\n')
    git('add', 'example.txt')
    git(
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'fixture',
    )
    const shown = await client.call(MANAGER_POST_METHOD.reference, {
      managerId: manager.id,
      reference: 'HEAD',
    })
    assert.match(shown.text, /evidence/)
    await client.fails(MANAGER_POST_METHOD.reference, {
      managerId: manager.id,
      reference: '--output=stolen',
    })
    await client.fails(MANAGER_POST_METHOD.reference, {
      managerId: manager.id,
      reference: 'missing-branch',
    })
    const plain = env.connect()
    await plain.initialize(['harness'])
    assert.equal(
      (
        await plain.fails(MANAGER_POST_METHOD.reference, {
          managerId: manager.id,
          reference: 'HEAD',
        })
      ).data?.litch,
      'extensionRequired',
    )
  } finally {
    await env.close()
  }
})
