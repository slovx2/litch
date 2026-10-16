import assert from 'node:assert/strict'
import test from 'node:test'
import { type Connection, openStage, type Stage } from './fixtures/in-process.mjs'

// 会话的预览（第一句话）和列表照上游（rust-v0.162.0-alpha.20）：
// - 预览是第一条用户消息，发出去就有，没有专门的通知：没订阅的客户端靠 thread/list、thread/read 拿。
// - 还没说过话就设了目标的，目标就是预览（state/src/extract.rs 的 ThreadGoalUpdated，只在预览为空时填）。
// - 状态库列会话时（state/src/runtime/threads.rs 的 push_thread_filters_with_preview）不列预览为空的，
//   也就是还没说过话的会话；看归档的、按父会话或祖先会话查的、指定了某个分区的照列。
//   官方桌面端在新对话页上会先建一个空会话、一阵子没用就删，这种会话不该出现在别的客户端的列表里。

const text = (value: string) => [{ type: 'text', text: value }]

async function withStage(name: string, run: (stage: Stage) => Promise<void>): Promise<void> {
  const stage = await openStage(name)
  try {
    await run(stage)
  } finally {
    await stage.dispose()
  }
}

const preview = async (connection: Connection, threadId: string) =>
  (await connection.request('thread/read', { threadId })).thread.preview

const ids = async (connection: Connection, params: Record<string, unknown> = {}) =>
  (await connection.request('thread/list', params)).data.map((thread: { id: string }) => thread.id)

test('PREVIEW-001：没说过话的会话不进 thread/list；看归档、按父会话查、指定分区时照列；第一句话一发出去就列出来、带着预览', async () => {
  await withStage('thread-preview-list', async (stage) => {
    const owner = await stage.connect('owner')
    const other = await stage.connect('other')
    const { thread: empty } = await owner.request('thread/start', { cwd: stage.directory })
    assert.equal(empty.preview, '')
    assert.ok(!(await ids(other)).includes(empty.id), '还没说过话的会话不列')
    assert.ok(!(await ids(other, { sectionId: null })).includes(empty.id), '“没分区的”也不列')
    assert.ok(
      !(await ids(other, { projectId: null, sortKey: 'updated_at' })).includes(empty.id),
      '带别的条件也不列',
    )
    assert.equal(
      (await other.request('thread/read', { threadId: empty.id })).thread.preview,
      '',
      '按标识读得到',
    )

    // 第一句话发出去、回合还没结束：列表里有了，预览就是这句话
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    stage.script = async (_context, handlers) => {
      await gate
      await handlers.onEvent({ type: 'text_delta', delta: '好的' })
      await handlers.onEvent({ type: 'completed', success: true, result: '好的' })
    }
    const { turn } = await owner.request('turn/start', {
      threadId: empty.id,
      input: text('出个计划\n分三步'),
    })
    const listed = (await other.request('thread/list', {})).data.find(
      (thread: { id: string }) => thread.id === empty.id,
    )
    assert.equal(listed?.preview, '出个计划\n分三步', '回合还在跑，列表里已经有它和它的预览')
    assert.equal(
      (await other.request('thread/read', { threadId: empty.id })).thread.preview,
      '出个计划\n分三步',
    )
    release()
    assert.equal((await owner.completed(turn.id)).status, 'completed')

    // 另一个空会话：放进分区、归档之后照列（上游指定了某个分区、看归档时不按预览筛）
    const { thread: pinned } = await owner.request('thread/start', { cwd: stage.directory })
    const { section } = await owner.request('threadSection/create', { name: '放着' })
    await owner.request('thread/section/move', { threadId: pinned.id, sectionId: section.id })
    assert.ok((await ids(other, { sectionId: section.id })).includes(pinned.id), '指定分区照列')
    assert.ok(!(await ids(other)).includes(pinned.id))
    await owner.request('thread/archive', { threadId: pinned.id })
    assert.ok((await ids(other, { archived: true })).includes(pinned.id), '看归档照列')

    // 分叉时一个回合都没带：也是没说过话的会话；按父会话查照列
    const { thread: blank } = await owner.request('thread/fork', {
      threadId: empty.id,
      cwd: stage.directory,
      beforeTurnId: turn.id,
    })
    assert.equal(blank.preview, '')
    assert.ok(!(await ids(other)).includes(blank.id))
    assert.ok((await ids(other, { parentThreadId: empty.id })).includes(blank.id), '按父会话查照列')
    assert.ok((await ids(other, { ancestorThreadId: empty.id })).includes(blank.id))
    assert.ok((await ids(other)).includes(empty.id))
  })
})

test('PREVIEW-002：还没说过话就设目标，目标就是预览；之后说的话、改的目标都不顶掉它；先说过话的不受目标影响', async () => {
  await withStage('thread-preview-goal', async (stage) => {
    const owner = await stage.connect('owner')
    const other = await stage.connect('other')
    const { thread: quiet } = await owner.request('thread/start', { cwd: stage.directory })
    await owner.request('thread/goal/set', {
      threadId: quiet.id,
      objective: '  把测试跑绿  ',
      status: 'paused',
    })
    assert.equal(await preview(other, quiet.id), '把测试跑绿')
    assert.ok((await ids(other)).includes(quiet.id), '只设了目标的会话照列')
    await owner.request('thread/goal/set', { threadId: quiet.id, objective: '换个目标' })
    assert.equal(await preview(other, quiet.id), '把测试跑绿', '只在预览为空时填')

    stage.script = async (_context, handlers) => {
      await handlers.onEvent({ type: 'text_delta', delta: '好的' })
      await handlers.onEvent({ type: 'completed', success: true, result: '好的' })
    }
    const { turn } = await owner.request('turn/start', {
      threadId: quiet.id,
      input: text('开始吧'),
    })
    assert.equal((await owner.completed(turn.id)).status, 'completed')
    assert.equal(await preview(other, quiet.id), '把测试跑绿', '后说的话不顶掉目标')

    const { thread: talked } = await owner.request('thread/start', { cwd: stage.directory })
    const { turn: first } = await owner.request('turn/start', {
      threadId: talked.id,
      input: text('先说一句'),
    })
    assert.equal((await owner.completed(first.id)).status, 'completed')
    await owner.request('thread/goal/set', {
      threadId: talked.id,
      objective: '后来的目标',
      status: 'paused',
    })
    assert.equal(await preview(other, talked.id), '先说一句')
  })
})
