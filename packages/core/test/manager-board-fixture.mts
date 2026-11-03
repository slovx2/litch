// 仅供隔离界面验收：普通界面仍用模拟核心，看板改走正式的 createManagers。
// 故意不发设备通知，并让提交后的整板读取挂起，验证成功回包足以更新两端。

import type { Manager, ManagerBoard } from '../../protocol/src/manager.mjs'
import { ChannelError } from '../src/channel/protocol.mjs'
import type { CoreHost } from '../src/channel/server.mjs'
import { createManagers, type ManagersHost } from '../src/device/manager.mjs'

export function managerBoardFixture(
  mock: CoreHost,
  data: { board: ManagerBoard; manager: Manager; rpcUrl?: string; paging?: boolean },
  factory = createManagers,
) {
  let submitted = false
  data.manager.pendingDecisions = data.board.decisions.filter((d) => d.status === 'open').length
  const state = {
    fail: false,
    reads: 0,
    submitted: false,
    deliveredAt: 0,
    startedAt: 0,
    acceptedAt: 0,
    statusPaintAt: 0,
    fullPaintAt: 0,
  }
  const wire = data.rpcUrl ? new WebSocket(data.rpcUrl) : null
  const pending = new Map<
    number,
    { method: string; resolve(value: unknown): void; reject(error: Error): void }
  >()
  let nextId = 0
  const host: ManagersHost = {
    deviceId: 'local',
    online: () => true,
    supported: () => true,
    features: () => ({ feedback: true, posts: true, ignore: true, paging: data.paging === true }),
    changed() {},
    log() {},
    fail: (error) => new ChannelError('internal', String(error)),
    request: (async (method: string, params: any) => {
      if (wire) {
        if (method.endsWith('/submit')) {
          if (state.fail) throw new Error('隔离测试：提交失败')
          state.startedAt = performance.now()
        }
        return new Promise((resolve, reject) => {
          const id = ++nextId
          pending.set(id, { method, resolve, reject })
          const send = () => wire.send(JSON.stringify({ id, method, params }))
          if (wire.readyState === WebSocket.OPEN) send()
          else wire.addEventListener('open', send, { once: true })
        })
      }
      if (method.endsWith('/list')) return { managers: [data.manager] }
      if (method.endsWith('/board/read')) {
        state.reads++
        if (submitted) return new Promise(() => {})
        return { board: structuredClone(data.board) }
      }
      if (state.fail) throw new Error('隔离测试：提交失败')
      submitted = state.submitted = true
      const accepted = params.answers.map((answer: any) => {
        const decision = data.board.decisions.find((d) => d.id === answer.decisionId)
        if (!decision) throw new Error('隔离看板中没有这个决策')
        return {
          ...decision,
          status: 'answered',
          revision: decision.revision + 1,
          answer: { by: 'user', at: 1_800_000_100, optionId: answer.optionId, text: answer.text },
        }
      })
      return {
        accepted,
        rejected: [],
        delivery: 'queued',
        acceptedRequests: [],
        rejectedRequests: [],
        acceptedQuestions: [],
        rejectedQuestions: [],
      }
    }) as ManagersHost['request'],
  }
  const service = factory(host)
  wire?.addEventListener('message', ({ data }) => {
    const frame = JSON.parse(String(data))
    if (frame.id) {
      const request = pending.get(frame.id)
      if (!request) return
      pending.delete(frame.id)
      if (frame.error) request.reject(new Error(frame.error))
      else {
        if (request.method.endsWith('/submit')) {
          state.submitted = true
          state.acceptedAt = performance.now()
        }
        request.resolve(frame.result)
      }
    } else service.notification(frame.method, frame.params)
  })
  service.resync()
  const core: CoreHost = {
    subscribe(topic, sink) {
      if (topic.kind === 'managers' && topic.deviceId === 'local') return service.open(sink)
      if (topic.kind === 'managerBoard' && topic.deviceId === 'local' && topic.managerId === 'm1') {
        state.deliveredAt = performance.now()
        return service.openBoard('m1', sink)
      }
      return mock.subscribe(topic, sink)
    },
    command(name, params: any, signal) {
      if (name === 'managers.report.read')
        return service.reportRead({
          managerId: params.managerId,
          id: params.id,
          revision: params.revision,
        })
      if (name === 'managers.board.page')
        return service.page(
          params.managerId,
          { kind: params.kind, status: params.status, order: params.order },
          params.more,
        )
      if (name === 'managers.board.detail') return service.detail(params.managerId, params.id)
      if (name === 'managers.board.history')
        return service.history(params.managerId, params.id, params.more)
      if (name === 'managers.board.refresh') return service.refresh(params.managerId, params.lines)
      if (name === 'managers.feedback.submit') {
        const { deviceId: _deviceId, ...feedback } = params
        return service.feedback(feedback)
      }
      if (name === 'managers.answers.submit')
        return service.submit(params.managerId, params.answers)
      return mock.command(name, params, signal)
    },
  }
  return { core, state }
}
