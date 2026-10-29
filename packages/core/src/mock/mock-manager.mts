// 模拟经理：与真实通道同形的快照、增量和命令，答复按项校验版本。
import { formatSessionEvent } from '../../../protocol/src/session-tree.mjs'
import { ChannelError, type Commands } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { ManagerAnswersResult, ManagerBoardView, ManagerView } from '../model-manager.mjs'
import type { MockTasksHost } from './mock-tasks.mjs'
import {
  type ManagerSessionSummary,
  sampleManagerHistory,
  sampleManagerOpening,
  sampleManagers,
} from './sample-manager.mjs'

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export interface MockManagerHost
  extends Pick<MockTasksHost, 'clock' | 'lang' | 'devices' | 'device' | 'spawn'> {
  say(deviceId: string, threadId: string, prompt: string, answer: string): void
  add(deviceId: string, session: ManagerSessionSummary): void
  mark(deviceId: string, threadId: string, manager: ManagerView): void
  /** 发出结束事件并开始收尾回合；回合停止时由宿主调用 turnEnded。 */
  ending(deviceId: string, threadId: string, prompt: string, answer: string): string
}

export function createMockManagers(host: MockManagerHost) {
  const states = new Map<string, ReturnType<typeof sampleManagers>>()
  const histories = new Map<string, ReturnType<typeof sampleManagerHistory>>()
  const lists = new Map<string, Set<HostSink>>()
  const boards = new Map<string, Set<HostSink>>()
  const endingTurns = new Map<string, string>()
  let seq = 0
  const t = (zh: string, en: string) => (host.lang === 'zh-CN' ? zh : en)
  const available = (id: string) => {
    const device = host.device(id)
    return device?.mode !== 'full' ? false : device.stale ? null : true
  }
  const state = (id: string) => {
    let value = states.get(id)
    if (!value) {
      value =
        available(id) === true
          ? sampleManagers(id, host.clock.now(), host.lang)
          : { managers: [], boards: [], sessions: [] }
      states.set(id, value)
      for (const session of value.sessions) host.add(id, session)
      for (const manager of value.managers) {
        const board = value.boards.find((board) => board.managerId === manager.id)
        if (board)
          histories.set(key(id, manager.threadId), sampleManagerHistory(manager, board, host.lang))
      }
    }
    return value
  }
  const key = (deviceId: string, managerId: string) => JSON.stringify([deviceId, managerId])
  const boardView = (deviceId: string, managerId: string) => ({
    deviceId,
    managerId,
    available: available(deviceId),
    board: state(deviceId).boards.find((b) => b.managerId === managerId) ?? null,
  })
  const publish = (deviceId: string, manager: ManagerView, board: ManagerBoardView) => {
    manager.pendingDecisions = board.decisions.filter((d) => d.status === 'open').length
    manager.latestActivity = board.activities[0] ?? null
    manager.updatedAt = host.clock.now()
    host.mark(deviceId, manager.threadId, manager)
    for (const sink of lists.get(deviceId) ?? [])
      sink.delta([{ op: 'manager.upsert', manager: copy(manager) }])
    for (const sink of boards.get(key(deviceId, manager.id)) ?? [])
      sink.delta([{ op: 'managerBoard.set', view: copy(boardView(deviceId, manager.id)) }])
  }
  const activity = (board: ManagerBoardView, text: string) =>
    board.activities.unshift({
      id: `mock-activity-${++seq}`,
      kind: 'manager',
      at: host.clock.now(),
      text,
      objectId: null,
      threadId: null,
      changeId: null,
    })
  const run = async (name: string, params: unknown): Promise<unknown> => {
    const { deviceId } = params as { deviceId: string }
    const device = host.device(deviceId)
    if (!device) throw new ChannelError('notFound', t('设备不存在', 'Device not found'))
    if (device.stale) throw new ChannelError('offline', t('设备未连接', 'Device is offline'))
    if (!available(deviceId))
      throw new ChannelError(
        'unsupported',
        t('此设备不支持经理', 'This device does not support managers'),
      )
    const data = state(deviceId)
    if (name === 'managers.create') {
      const { manager: draft } = params as Commands['managers.create']['params']
      if (
        !draft.scope.trim() ||
        !Number.isInteger(draft.dispatch.maxRunningLines) ||
        draft.dispatch.maxRunningLines < 1
      )
        throw new ChannelError(
          'invalid',
          t('范围和并行线数无效', 'Invalid scope or concurrent line limit'),
        )
      const id = `manager-${++seq}`
      const threadId = host.spawn(deviceId, {
        harness: draft.harness,
        cwd: draft.cwd,
        workspaceId: null,
        title: draft.name || draft.scope,
      })
      const { firstTask, ...settings } = copy(draft)
      const manager: ManagerView = {
        ...settings,
        id,
        deviceId,
        threadId,
        status: 'active',
        pendingDecisions: 0,
        runningLines: 0,
        latestActivity: null,
        createdAt: host.clock.now(),
        updatedAt: host.clock.now(),
        endedAt: null,
      }
      const board: ManagerBoardView = {
        deviceId,
        managerId: id,
        situation: null,
        decisions: [],
        items: [],
        lines: [],
        activities: [],
        changes: [],
      }
      data.managers.push(manager)
      data.boards.push(board)
      host.say(
        deviceId,
        threadId,
        firstTask.trim() ? firstTask : sampleManagerOpening(manager, host.lang),
        t(
          '已建立看板，先整理计划，等待开始。',
          'The board is ready. I will organize the plan and wait to start.',
        ),
      )
      activity(board, t('经理已建立', 'Manager created'))
      publish(deviceId, manager, board)
      return { manager: copy(manager), threadId }
    }
    const { managerId } = params as { managerId: string }
    const manager = data.managers.find((m) => m.id === managerId)
    const board = data.boards.find((b) => b.managerId === managerId)
    if (!manager || !board) throw new ChannelError('notFound', t('经理不存在', 'Manager not found'))
    if (manager.status !== 'active')
      throw new ChannelError(
        'rejected',
        manager.status === 'ending'
          ? t('经理正在收尾，看板只读', 'The manager is wrapping up; the board is read-only')
          : t('经理已结束，看板只读', 'The manager has ended; the board is read-only'),
      )
    let result: unknown
    if (name === 'managers.update') {
      const { patch } = params as Commands['managers.update']['params']
      if (patch.scope !== undefined && !patch.scope.trim())
        throw new ChannelError('invalid', t('范围不能为空', 'Scope is required'))
      if (
        patch.dispatch &&
        (!Number.isInteger(patch.dispatch.maxRunningLines) || patch.dispatch.maxRunningLines < 1)
      )
        throw new ChannelError(
          'invalid',
          t('并行线数必须为正整数', 'The concurrent line limit must be a positive integer'),
        )
      const rulesChanged =
        (patch.scope !== undefined && patch.scope !== manager.scope) ||
        (patch.rules !== undefined && patch.rules !== manager.rules)
      Object.assign(manager, copy(patch))
      if (rulesChanged) {
        host.say(
          deviceId,
          manager.threadId,
          formatSessionEvent({
            kind: 'manager-rules',
            notes: [],
            manager: { managerId, text: `${manager.scope}\n\n${manager.rules}` },
          }),
          t(
            '已更新范围和规矩，将按新约定安排工作。',
            'Scope and rules updated. I will follow the new instructions.',
          ),
        )
      }
      result = { manager }
    } else if (name === 'managers.end') {
      manager.status = 'ending'
      activity(board, t('经理正在收尾', 'Manager is wrapping up'))
      const turnId = host.ending(
        deviceId,
        manager.threadId,
        formatSessionEvent({
          kind: 'manager-end',
          notes: [],
          manager: {
            managerId,
            text: t(
              '请整理总结，保留未完成事项。',
              'Summarize the work and preserve unfinished items.',
            ),
          },
        }),
        t(
          '本轮工作已结束，已整理工作结果，未完成事项和决策保留在看板上。',
          'This round has ended. The results are summarized, and unfinished items and decisions remain on the board.',
        ),
      )
      endingTurns.set(key(deviceId, manager.threadId), turnId)
      result = { manager }
    } else if (name === 'managers.decision.reopen') {
      const { decisionId } = params as Commands['managers.decision.reopen']['params']
      const decision = board.decisions.find((d) => d.id === decisionId)
      if (!decision) throw new ChannelError('notFound', t('决策不存在', 'Decision not found'))
      if (decision.status !== 'expired' && decision.status !== 'withdrawn')
        throw new ChannelError(
          'rejected',
          t('只能重开已关闭的决策', 'Only closed decisions can be reopened'),
        )
      decision.status = 'open'
      decision.closed = null
      decision.revision++
      decision.updatedAt = host.clock.now()
      activity(board, t(`你重开了 ${decisionId}`, `You reopened ${decisionId}`))
      result = { decision }
    } else {
      const { answers } = params as Commands['managers.answers.submit']['params']
      const submitted: ManagerAnswersResult = { accepted: [], rejected: [], delivery: 'none' }
      const seen = new Set<string>()
      for (const answer of answers) {
        const decision = board.decisions.find((d) => d.id === answer.decisionId)
        const duplicate = seen.has(answer.decisionId)
        seen.add(answer.decisionId)
        const code = !decision
          ? 'unknownDecision'
          : duplicate
            ? 'invalidAnswer'
            : decision.revision !== answer.revision
              ? 'decisionConflict'
              : decision.status !== 'open'
                ? 'decisionNotOpen'
                : (answer.optionId !== null &&
                      !decision.options.some((o) => o.id === answer.optionId)) ||
                    (answer.optionId === null && !answer.text.trim())
                  ? 'invalidAnswer'
                  : null
        if (code || !decision) {
          submitted.rejected.push({
            decisionId: answer.decisionId,
            code: code ?? 'unknownDecision',
            message: t(
              '决策已变化或答复无效，请核对后重交',
              'The decision changed or the answer is invalid. Review and resubmit.',
            ),
            decision: decision ? copy(decision) : null,
          })
          continue
        }
        decision.answer = {
          optionId: answer.optionId,
          text: answer.text,
          by: 'user',
          at: host.clock.now(),
        }
        decision.status = 'answered'
        decision.revision++
        decision.updatedAt = host.clock.now()
        submitted.accepted.push(decision)
      }
      if (submitted.accepted.length) {
        submitted.delivery = 'queued'
        const text = t(
          `你在看板上答复了 ${submitted.accepted.length} 项决策`,
          `You answered ${submitted.accepted.length} decisions on the board`,
        )
        host.say(
          deviceId,
          manager.threadId,
          formatSessionEvent({
            kind: 'manager-answers',
            notes: [],
            manager: {
              managerId,
              text,
              answers: submitted.accepted.map((decision) => ({
                decisionId: decision.id,
                title: decision.title,
                optionId: decision.answer?.optionId ?? null,
                optionLabel:
                  decision.options.find((option) => option.id === decision.answer?.optionId)
                    ?.label ?? null,
                text: decision.answer?.text ?? '',
              })),
            },
          }),
          t(
            '已收到答复，将据此安排后续工作。',
            'Answers received. I will use them to plan the next steps.',
          ),
        )
        activity(board, text)
      }
      result = submitted
    }
    publish(deviceId, manager, board)
    return copy(result)
  }
  for (const device of host.devices()) state(device.id)
  const readOnlyNote = (deviceId: string, threadId: string): string | null => {
    const manager = state(deviceId).managers.find((entry) => entry.threadId === threadId)
    if (!manager || manager.status === 'active') return null
    return manager.status === 'ending'
      ? t(
          '经理正在收尾，对话和看板只读',
          'The manager is wrapping up. Chat and board are read-only.',
        )
      : t('经理已结束，对话和看板只读', 'This manager has ended. Chat and board are read-only.')
  }
  return {
    readOnlyNote,
    history(deviceId: string, threadId: string) {
      const history = histories.get(key(deviceId, threadId))
      return history ? copy(history) : undefined
    },
    readOnly(deviceId: string, threadId: string): boolean {
      return readOnlyNote(deviceId, threadId) !== null
    },
    turnEnded(deviceId: string, threadId: string, turnId: string) {
      const id = key(deviceId, threadId)
      if (endingTurns.get(id) !== turnId) return
      endingTurns.delete(id)
      const data = state(deviceId)
      const manager = data.managers.find((entry) => entry.threadId === threadId)
      const board = data.boards.find((entry) => entry.managerId === manager?.id)
      if (!manager || !board) return
      manager.status = 'ended'
      manager.endedAt = host.clock.now()
      activity(board, t('经理已结束，看板只读', 'Manager ended; board is read-only'))
      publish(deviceId, manager, board)
    },
    subscribe(deviceId: string, sink: HostSink, managerId?: string) {
      const map = managerId === undefined ? lists : boards
      const id = managerId === undefined ? deviceId : key(deviceId, managerId)
      const sinks = map.get(id) ?? new Set<HostSink>()
      map.set(id, sinks)
      sinks.add(sink)
      sink.snapshot(
        copy(
          managerId === undefined
            ? { deviceId, available: available(deviceId), managers: state(deviceId).managers }
            : boardView(deviceId, managerId),
        ),
      )
      return () => {
        sinks.delete(sink)
      }
    },
    command(name: string, params: unknown): Promise<unknown> | undefined {
      return [
        'managers.create',
        'managers.update',
        'managers.end',
        'managers.answers.submit',
        'managers.decision.reopen',
      ].includes(name)
        ? run(name, params)
        : undefined
    },
  }
}
