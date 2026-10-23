// 子会话、提案、交接的目录规则（worktrees 扩展加会话树）：父会话在设备层工作树里（自己建的、或共用着祖先的）时，
// 没说的子会话开新工作树、从父会话分支的最新提交切（没提交的改动不带）；在普通目录时共用；worktree 明说的照办；
// 分叉时引擎不认 cwd 的退回共用、刚建的删掉；提案上记模型或用户定的和照缺省算的，开始时卡上的为准。
// 上游是假引擎（fake-engine.mts），仓库是真的 git 仓库。
import assert from 'node:assert/strict'
import { readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { failureOf, resultOf } from './fake-engine.mjs'
import { tempDir } from './helpers.mjs'
import { brief, ECHO_SPEC, SESSIONS, TREE, text, treeRig, until } from './tree-kit.mjs'
import { commitAll, makeRepo, sh, write } from './worktree-kit.mjs'

function world() {
  const dir = realpathSync(tempDir())
  const repo = makeRepo(dir)
  const env = treeRig()
  const list = () => env.device.worktrees?.list() ?? []
  return {
    env,
    repo,
    list,
    async client() {
      const client = env.connect()
      await client.initialize([...TREE, 'worktrees'], {
        litchClientTools: { namespaces: ['litch_echo'] },
      })
      return client
    },
    async done() {
      await env.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

type World = ReturnType<typeof world>

/** 在 pi 上建父会话（worktree 为真时在新工作树里），发一个用户回合 */
async function parentIn(w: World, client: Awaited<ReturnType<World['client']>>, worktree: boolean) {
  const started = await client.call('thread/start', {
    harness: 'pi',
    cwd: w.repo,
    dynamicTools: [ECHO_SPEC],
    ...(worktree ? { litchWorktree: { title: 'Parent work' } } : {}),
  })
  const threadId = started.thread.id as string
  if (worktree)
    await until(() => w.env.device.worktrees?.forThread(threadId) != null, '父会话记成主人')
  await client.call('turn/start', { threadId, input: text('帮我派一个子会话') })
  return { threadId, cwd: started.thread.cwd as string }
}

const start = (w: World, threadId: string, args: Record<string, unknown>) =>
  w.env.pi.callTool(threadId, SESSIONS, 'start', {
    initiation: 'user_asked',
    title: 'Child task',
    ...brief('做一件独立的事'),
    ...args,
  })

test('WTC-001：父会话在普通目录：没说的共用目录；worktree 为真从当前 HEAD 开新的；不在仓库里的回 invalid', async () => {
  const w = world()
  try {
    const client = await w.client()
    const { threadId } = await parentIn(w, client, false)
    const shared = resultOf((await start(w, threadId, {}))?.answer)
    assert.equal(w.list().length, 0, '没开工作树')
    assert.equal(w.env.pi.threads.find((one) => one.id === shared.thread_id)?.cwd, w.repo)
    const own = resultOf(
      (await start(w, threadId, { title: 'Own branch', worktree: true }))?.answer,
    )
    const [made] = w.list()
    assert.ok(made)
    assert.equal(made.baseRef, 'HEAD')
    assert.equal(made.ownerThreadId, own.thread_id)
    assert.match(own.note, new RegExp(`in a new git worktree on branch ${made.branch}`))
    assert.equal(w.env.pi.threads.find((one) => one.id === own.thread_id)?.cwd, made.path)
    // 不在 git 仓库里：明说要的拒绝，没说的照旧共用
    const plain = await client.call('thread/start', {
      harness: 'pi',
      cwd: '/work/plain',
      dynamicTools: [ECHO_SPEC],
    })
    const plainId = plain.thread.id as string
    await client.call('turn/start', { threadId: plainId, input: text('再派一个') })
    const refused = await start(w, plainId, { worktree: true })
    assert.equal(failureOf(refused?.answer), 'invalid')
    assert.match(
      refused?.answer.result.contentItems[0].text,
      /Could not create a worktree from \/work\/plain/,
    )
    assert.equal(w.list().length, 1)
  } finally {
    await w.done()
  }
})

test('WTC-002：父会话在工作树里：没说的从父会话分支尖开新的（未提交的不带）；为假的共用那棵，孙会话照样开新的', async () => {
  const w = world()
  try {
    const client = await w.client()
    const { threadId, cwd } = await parentIn(w, client, true)
    const host = w.env.device.worktrees?.forThread(threadId)
    assert.ok(host)
    assert.equal(cwd, host.path)
    // 父会话在自己的分支上提交了一个，又改了没提交
    write(host.path, 'src/app.txt', 'v2\n')
    const tip = commitAll(host.path, 'parent change')
    write(host.path, 'src/app.txt', 'v3 uncommitted\n')
    const child = resultOf((await start(w, threadId, {}))?.answer)
    const made = w.env.device.worktrees?.forThread(child.thread_id)
    assert.ok(made, '子会话有自己的工作树')
    assert.notEqual(made.id, host.id)
    assert.equal(made.baseRef, host.branch)
    assert.equal(made.baseCommit, tip)
    assert.equal(made.sourceRoot, w.repo, '记在主仓库下')
    assert.equal(readFileSync(join(made.path, 'src/app.txt'), 'utf8'), 'v2\n')
    // 共用：目录就是父会话那棵
    const sharing = resultOf(
      (await start(w, threadId, { title: 'Share it', worktree: false }))?.answer,
    )
    assert.equal(w.env.pi.threads.find((one) => one.id === sharing.thread_id)?.cwd, host.path)
    assert.equal(w.env.device.worktrees?.forThread(sharing.thread_id), null)
    // 共用着的子会话再派：宿主还是那棵，开新的
    w.env.pi.end(sharing.thread_id, 'completed', '简报收到')
    await client.call('turn/start', { threadId: sharing.thread_id, input: text('你也派一个') })
    const grand = resultOf((await start(w, sharing.thread_id, { title: 'Grandchild' }))?.answer)
    const grandTree = w.env.device.worktrees?.forThread(grand.thread_id)
    assert.ok(grandTree)
    assert.equal(grandTree.baseRef, host.branch)
    assert.equal(sh(grandTree.path, 'symbolic-ref', '--short', 'HEAD'), grandTree.branch)
  } finally {
    await w.done()
  }
})

test('WTC-003：交接（分叉）：引擎不认 cwd 的退回共用、刚建的删掉；认的在新工作树里', async () => {
  const w = world()
  try {
    const client = await w.client()
    const { threadId } = await parentIn(w, client, true)
    const host = w.env.device.worktrees?.forThread(threadId)
    assert.ok(host)
    await client.call('turn/start', { threadId, input: text('无关的新消息') }).catch(() => null)
    const ignored = resultOf(
      (
        await w.env.pi.callTool(threadId, SESSIONS, 'hand_off', {
          title: 'Hand off',
          remaining_plan: '剩下的两步',
        })
      )?.answer,
    )
    assert.doesNotMatch(ignored.note, /worktree/)
    await until(() => w.list().length === 1, '没用上的工作树删掉了')
    // 认 cwd 的引擎
    const fork = w.env.pi.handlers['thread/fork'] as NonNullable<(typeof w.env.pi.handlers)[string]>
    w.env.pi.handlers['thread/fork'] = (params, connection) => {
      const made = fork(params, connection) as { thread: Record<string, unknown> }
      const thread = w.env.pi.threads.find((one) => one.id === made.thread.id)
      if (thread && params.cwd) thread.cwd = params.cwd
      return { ...made, thread: { ...made.thread, cwd: params.cwd ?? made.thread.cwd } }
    }
    const moved = resultOf(
      (
        await w.env.pi.callTool(threadId, SESSIONS, 'hand_off', {
          title: 'Hand off 2',
          remaining_plan: '剩下的一步',
        })
      )?.answer,
    )
    const made = w.env.device.worktrees?.forThread(moved.thread_id)
    assert.ok(made)
    assert.equal(made.baseRef, host.branch)
    assert.match(moved.note, /in a new git worktree on branch/)
    assert.equal(w.env.pi.sent('thread/fork').at(-1)?.cwd, made.path)
  } finally {
    await w.done()
  }
})

test('WTC-004：提案记下缺省和模型定的；开始时卡上改的为准；offer 卡上选新会话带回的开关照着开', async () => {
  const w = world()
  try {
    const client = await w.client()
    const { threadId } = await parentIn(w, client, true)
    const host = w.env.device.worktrees?.forThread(threadId)
    assert.ok(host)
    const proposed = resultOf(
      (await start(w, threadId, { initiation: 'propose', title: 'Later' }))?.answer,
    )
    const [card] = w.env.device.sessionTree.proposals(threadId)
    assert.equal(card?.id, proposed.proposal_id)
    assert.equal(card?.worktree, null)
    assert.equal(card?.worktreeDefault, true)
    const told = resultOf(
      (await start(w, threadId, { initiation: 'propose', title: 'Shared later', worktree: false }))
        ?.answer,
    )
    assert.equal(w.env.device.sessionTree.proposal(told.proposal_id)?.worktree, false)
    // 用户在卡上把第一张改成共用
    const accepted = await client.call('litch/sessionProposal/accept', {
      proposalId: proposed.proposal_id,
      overrides: { worktree: false },
    })
    assert.equal(w.env.pi.threads.find((one) => one.id === accepted.threadId)?.cwd, host.path)
    assert.equal(w.env.device.worktrees?.forThread(accepted.threadId), null)
    // 普通目录里的父会话：缺省是共用
    const plain = await parentIn(w, client, false)
    const other = resultOf(
      (await start(w, plain.threadId, { initiation: 'propose', title: 'Plain' }))?.answer,
    )
    assert.equal(w.env.device.sessionTree.proposal(other.proposal_id)?.worktreeDefault, false)
    // offer：用户选新会话时开了工作树，模型补简报开起来
    const offering = start(w, plain.threadId, {
      initiation: 'offer',
      title: 'Offer',
      prompt: undefined,
      background: undefined,
    })
    await until(
      () => w.env.device.sessionTree.proposals(plain.threadId).some((one) => one.offer),
      'offer 卡',
    )
    const offer = w.env.device.sessionTree.proposals(plain.threadId).find((one) => one.offer)
    assert.ok(offer)
    await client.call('litch/sessionProposal/answer', {
      proposalId: offer.id,
      choice: 'session',
      worktree: true,
    })
    resultOf((await offering)?.answer)
    const opened = resultOf(
      (
        await w.env.pi.callTool(plain.threadId, SESSIONS, 'accept', {
          proposal_id: offer.id,
          ...brief('做 offer 那件事'),
        })
      )?.answer,
    )
    const made = w.env.device.worktrees?.forThread(opened.thread_id)
    assert.ok(made, 'offer 开出来的子会话在新工作树里')
    assert.equal(made.baseRef, 'HEAD')
  } finally {
    await w.done()
  }
})
