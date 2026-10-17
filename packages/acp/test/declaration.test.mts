import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import type { HarnessFeatures, PermissionPreset } from '../../protocol/src/harness-capabilities.mjs'
import { dispose, type Scene, scene, text, turn, violations } from './client.mjs'

// 这个文件守着 `runtime/info` 里的结构化声明（src/declaration.mts）和实际行为一致：
// 声明支持的调了确实成，声明不支持的调了确实被拒。声明跟着 agent 握手时报的能力走，两种 agent 各验一遍。

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// 按声明调用：声明支持的必须成功；不支持的必须答“方法不存在”或“不适用”，不能假装成功。
async function declared(s: Scene, supported: boolean, method: string, params: unknown) {
  if (supported) return s.desktop.call(method, params)
  await assert.rejects(s.desktop.call(method, params), (error: any) =>
    [-32601, -32004].includes(error.code),
  )
  return null
}

async function check(s: Scene): Promise<void> {
  const info = await s.desktop.call('runtime/info', {})
  const features = info.features as HarnessFeatures
  const presets = info.permissionPresets as PermissionPreset[]
  const caps = s.server.runtime.known
  assert.ok(caps, 'runtime/info 要先握手')
  assert.equal(features.fork, caps.fork)
  assert.equal(features.inputTypes.includes('image'), caps.image)

  // 只有一档权限，新建会话用它
  assert.deepEqual(
    presets.map((preset) => preset.id),
    [':danger-full-access'],
  )
  const started = await s.desktop.call('thread/start', {
    cwd: s.cwd,
    permissions: presets[0]?.id,
  })
  const id = started.thread.id
  assert.equal(started.activePermissionProfile.id, presets[0]?.id)

  // 计划更新
  await turn(s, id, text('hello'))
  assert.equal(
    s.desktop.notifications.some((n) => n.method === 'turn/plan/updated'),
    features.planUpdates,
  )
  // 审批的种类
  s.desktop.onRequest(() => ({ decision: 'accept' }))
  await turn(s, id, text('run'))
  await turn(s, id, text(`edit ${join(s.cwd, 'x.txt')}`))
  const kinds = new Set(
    s.desktop.requests.map((r) =>
      r.method === 'item/fileChange/requestApproval' ? 'fileChange' : 'command',
    ),
  )
  assert.deepEqual([...kinds].sort(), [...features.approvals.kinds].sort())
  assert.equal(
    s.desktop.requests.some((r) => r.method === 'item/tool/requestUserInput'),
    features.userInput,
  )

  // 图片输入
  const image = [{ type: 'image', url: `data:image/png;base64,${PIXEL}` }, ...text('看图')]
  if (features.inputTypes.includes('image')) {
    const done = await turn(s, id, image)
    assert.equal(done.status, 'completed')
  } else
    await assert.rejects(
      s.desktop.call('turn/start', { threadId: id, input: image }),
      (error: any) => error.code === -32602,
    )

  // 回合层面
  await declared(s, features.steer, 'turn/steer', {
    threadId: id,
    expectedTurnId: 'turn:1',
    input: text('插话'),
  })
  await declared(s, features.compact, 'thread/compact/start', { threadId: id })
  await declared(s, features.revert.byCount, 'thread/rollback', { threadId: id, numTurns: 1 })
  await declared(s, features.revert.byTurnId, 'thread/revert', {
    threadId: id,
    beforeTurnId: 'turn:1',
  })
  const forked = await declared(s, features.fork, 'thread/fork', { threadId: id })
  if (forked) assert.equal(forked.thread.forkedFromId, id)

  // 会话层面
  await declared(s, features.rename, 'thread/name/set', { threadId: id, name: '改个名' })
  await declared(s, features.archive, 'thread/archive', { threadId: id })
  await declared(s, features.archive, 'thread/unarchive', { threadId: id })
  await declared(s, features.delete, 'thread/delete', { threadId: id })
  assert.deepEqual([...violations], [])
}

test('能力全的 agent（有 load、list、fork、resume，收图片）', async () => {
  const s = await scene()
  try {
    await check(s)
  } finally {
    await dispose(s)
  }
})

test('什么都没声明的 agent：不能分叉，不收图片', async () => {
  const s = await scene({ FAKE_ACP_CAPS: JSON.stringify({}) })
  try {
    await check(s)
  } finally {
    await dispose(s)
  }
})

test('agent 起不来时 runtime/info 照保守的报：各项按没有算', async () => {
  const s = await scene({ CHA_ACP_CLI: '/nonexistent/agent' })
  try {
    const info = await s.desktop.call('runtime/info', {})
    assert.equal(info.engine, 'acp')
    assert.equal(info.cliBuild, 'unknown')
    assert.equal(info.features.fork, false)
    assert.deepEqual(info.features.inputTypes, ['text', 'skill', 'mention'])
    await assert.rejects(s.desktop.call('thread/start', { cwd: s.cwd }), /CLI 不可执行或未找到/)
  } finally {
    await dispose(s)
  }
})
