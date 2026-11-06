import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ClientToolContext, ClientToolInvocation } from '../../client-tools/types.mjs'
import { createComputerExecutor } from '../executor.mjs'
import { HelperClient } from '../helper-client.mjs'
import { encodeFrame, FrameReader } from '../wire.mjs'

// 真实执行器和帧客户端，模拟助手逐字输入；取消前后都记录实际落下的字符数。
for (const reason of ['abort', 'esc', 'turnEnded', 'oldHelper', 'otherTurn', 'otherApp'] as const) {
  test(`Windows 在途动作取消边界：${reason}`, async () => {
    const frames: any[] = []
    const reader = new FrameReader()
    let receive!: (data: Buffer) => void
    let cancelled = false
    let typed = 0
    let onStarted!: () => void
    let onFinished!: () => void
    const started = new Promise<void>((resolve) => {
      onStarted = resolve
    })
    const finished = new Promise<void>((resolve) => {
      onFinished = resolve
    })
    const client = new HelperClient({
      onData: (fn) => {
        receive = fn
      },
      onClose: () => {},
      close: () => {},
      write(data) {
        reader.push(data)
        for (let raw = reader.next(); raw !== undefined; raw = reader.next()) {
          const frame = raw as any
          frames.push(frame)
          const reply = (result: unknown) => receive(encodeFrame({ id: frame.id, result }))
          if (frame.method === 'listApps') {
            reply({
              apps: [{ appId: 'editor.exe', name: 'Editor', integrity: 'medium', windows: [] }],
            })
          } else if (frame.method === 'typeText') {
            const timer = setInterval(() => {
              if (!cancelled) typed++
              if (typed === 3) onStarted()
              if (cancelled || typed === 20) {
                clearInterval(timer)
                reply({})
                onFinished()
              }
            }, 1)
          } else if (frame.method === 'cancelAction') {
            cancelled =
              reason !== 'oldHelper' &&
              frame.params.actionId === frames.find((f) => f.method === 'typeText').params.actionId
            if (frame.id !== undefined) reply({})
          } else if (frame.method === 'getAppState') {
            receive(encodeFrame({ id: frame.id, error: { message: 'not needed in this test' } }))
          } else {
            reply({})
          }
        }
      },
    })
    const executor = createComputerExecutor({
      platform: 'win32',
      helper: { client: async () => client, connected: client, restart: async () => {} },
    })
    const controller = new AbortController()
    const unrelated = reason === 'otherTurn' || reason === 'otherApp'
    const invocation = {
      id: `typing-${reason}`,
      namespace: 'litch_computer',
      tool: 'type_text',
      arguments: { app: 'Editor', text: 'abcdefghijklmnopqrst' },
      device: { id: 'local' },
      threadId: 's',
      turnId: 'turn',
    } as ClientToolInvocation
    const result = executor.call(invocation, { signal: controller.signal } as ClientToolContext)
    await started
    if (reason === 'abort' || reason === 'oldHelper') controller.abort()
    if (reason === 'esc') executor.stopped({ session: 'local/s', appId: 'editor.exe' })
    if (reason === 'turnEnded')
      executor.turnEnded?.({ deviceId: 'local', threadId: 's', turnId: 'turn' })
    if (reason === 'otherTurn')
      executor.turnEnded?.({ deviceId: 'local', threadId: 's', turnId: 'old-turn' })
    if (reason === 'otherApp') executor.stopped({ session: 'local/s', appId: 'other.exe' })
    await finished
    const response = await result
    assert.equal(
      typed,
      reason === 'oldHelper' || unrelated ? 20 : 3,
      `停止后实际输入 ${typed}/20 个字符`,
    )
    assert.equal(response.success, unrelated)
    assert.equal(frames.find((f) => f.method === 'typeText').params.actionId, invocation.id)
    assert.equal(frames.filter((f) => f.method === 'cancelAction').length, unrelated ? 0 : 1)
    assert.equal(
      frames.some((f) => f.method === 'getAppState'),
      unrelated,
      '取消后不再观察目标',
    )
  })
}
