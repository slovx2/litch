// 看板对象的原子修改和状态流转；不接受模型写入运行事实。

import { MANAGER_ANSWERS_TEXT } from '../../protocol/src/client-tools-manager.mjs'
import type {
  ManagerActor,
  ManagerAnswersSubmitResponse,
  ManagerDecision,
  ManagerDecisionId,
  ManagerItem,
  ManagerItemId,
  ManagerObjectId,
  ManagerSubmittedAnswer,
} from '../../protocol/src/manager.mjs'
import { formatSessionEvent } from '../../protocol/src/session-tree.mjs'
import { type BoardObject, type ManagerStore, managerNow } from './manager-store.mjs'
import { fields, invalid, ManagerError, text, validateTool } from './manager-validate.mjs'

export const isDecision = (object: BoardObject): object is ManagerDecision =>
  object.id.startsWith('D-')
export class ManagerBoardWriter {
  readonly store: ManagerStore
  readonly belongs: (managerId: string, threadId: string) => boolean
  constructor(store: ManagerStore, belongs: (managerId: string, threadId: string) => boolean) {
    this.store = store
    this.belongs = belongs
  }
  active(managerId: string): void {
    const manager = this.store.manager(managerId)
    if (!manager) throw new ManagerError('unknownManager', 'This manager does not exist.')
    if (manager.status !== 'active')
      throw new ManagerError(
        'managerEnded',
        manager.status === 'ending'
          ? 'This manager is ending; only its finalization turn can write to the board.'
          : 'This manager has ended; its board is read-only.',
      )
  }
  object(managerId: string, id: unknown): BoardObject {
    const object = this.store.object(managerId, text(id, 'id'))
    if (!object)
      throw new ManagerError('unknownDecision', 'This object does not belong to this board.')
    return object
  }
  private validate(managerId: string, object: BoardObject): void {
    text(object.title, 'title')
    const reference = (id: string, prefix: string) => {
      if (!id.startsWith(prefix) || !this.store.object(managerId, id))
        invalid(`Unknown board reference: ${id}.`)
    }
    if (isDecision(object)) {
      const ids = new Set<string>()
      for (const option of object.options) {
        text(option.id, 'options.id')
        text(option.label, 'options.label')
        if (ids.has(option.id)) invalid('Option ids must be unique.')
        ids.add(option.id)
      }
      if (object.recommend !== null && !ids.has(object.recommend))
        invalid('recommend must refer to an existing option.')
      if (object.default.kind === 'option' && !ids.has(object.default.optionId))
        invalid('default must refer to an existing option.')
      // 已答复的选项是历史事实，不能被后续修改删掉。
      if (object.answer?.optionId && !ids.has(object.answer.optionId))
        invalid('The answered option cannot be removed.')
      for (const id of object.blocks) reference(id, 'I-')
    } else {
      for (const id of object.blockedBy) reference(id, 'D-')
      if (object.status === 'blocked') text(object.why, 'why')
      if (object.owner.kind === 'line' && !this.belongs(managerId, object.owner.threadId))
        invalid('owner must be a line of this manager.')
    }
  }
  private save(
    managerId: string,
    before: BoardObject | null,
    after: BoardObject,
    by: ManagerActor,
    why: string,
  ): BoardObject {
    this.validate(managerId, after)
    this.store.saveObject(managerId, after)
    this.store.record(managerId, after.id, by, before, after, why)
    return after
  }
  private change(
    managerId: string,
    before: BoardObject,
    patch: object,
    by: ManagerActor,
    why: string,
  ): BoardObject {
    return this.save(
      managerId,
      before,
      { ...before, ...patch, revision: before.revision + 1, updatedAt: managerNow() },
      by,
      why,
    )
  }
  tool(managerId: string, tool: string, given: unknown, turnId?: string): unknown {
    const args = validateTool(tool, given)
    if (tool === 'get') {
      const object = this.object(managerId, args.id)
      return {
        object,
        changes: this.store.changes(managerId).filter((change) => change.objectId === object.id),
      }
    }
    const manager = this.store.manager(managerId)
    if (manager?.status === 'ending' && turnId && this.store.ending(managerId)?.turnId === turnId) {
      if (!['status', 'close', 'update', 'verify'].includes(tool))
        invalid('During finalization, only status, close, update and verify are available.')
      if (
        tool === 'update' &&
        args.kind === 'decision' &&
        Object.keys(fields(args.patch)).some((key) => key !== 'landed')
      )
        invalid('During finalization, decision updates may only record landed locations.')
    } else this.active(managerId)
    return this.store.transaction(() => {
      if (tool === 'status') {
        const situation = { text: text(args.text, 'text'), at: managerNow() }
        this.store.record(
          managerId,
          'status',
          'manager',
          this.store.situation(managerId),
          situation,
          'Situation updated',
        )
        this.store.saveSituation(managerId, situation)
        return { situation }
      }
      if (tool === 'add') {
        const at = managerNow()
        const common = { revision: 1, checked: null, createdAt: at, updatedAt: at }
        const object: BoardObject =
          args.kind === 'decision'
            ? ({
                title: '',
                background: '',
                options: [],
                recommend: null,
                default: { kind: 'ask' },
                blocks: [],
                links: [],
                basis: [],
                landed: [],
                ...fields(args.decision),
                ...common,
                id: this.store.nextId(managerId, 'D') as ManagerDecisionId,
                status: 'open',
                answer: null,
                closed: null,
              } as ManagerDecision)
            : ({
                title: '',
                status: 'backlog',
                owner: { kind: 'manager' },
                blockedBy: [],
                why: '',
                links: [],
                basis: [],
                unverified: [],
                ...fields(args.item),
                ...common,
                id: this.store.nextId(managerId, 'I') as ManagerItemId,
              } as ManagerItem)
        this.save(managerId, null, object, 'manager', 'Object added')
        return { id: object.id, object }
      }
      const before = this.object(managerId, args.id)
      if (args.kind && (args.kind === 'decision') !== isDecision(before))
        invalid('kind does not match the object id.')
      let patch: object
      let why: string
      let by: ManagerActor = 'manager'
      switch (tool) {
        case 'update':
          patch = fields(args.patch)
          if (!Object.keys(patch).length) invalid('patch must not be empty.')
          why = text(args.why, 'why')
          break
        case 'verify':
          patch = { checked: { commit: args.commit, at: managerNow() } }
          why = text(args.why, 'why')
          break
        case 'close':
          why = text(args.reason, 'reason')
          if (isDecision(before) && before.status !== 'open')
            invalid('Only open decisions can be closed.')
          patch = {
            status: args.status,
            ...(isDecision(before) ? { closed: { reason: why, by, at: managerNow() } } : {}),
          }
          break
        case 'answer': {
          if (!isDecision(before)) invalid('Only decisions can be answered.')
          const error = this.answerFailure(before, {
            decisionId: before.id,
            revision: before.revision,
            optionId: args.optionId as string | null,
            text: args.text as string,
          })
          if (error) invalid(error)
          by = 'user-conversation'
          why = 'User answered in conversation'
          patch = {
            status: 'answered',
            answer: { optionId: args.optionId, text: args.text, by, at: managerNow() },
          }
          break
        }
        default:
          invalid(`Unknown write operation: ${tool}.`)
      }
      return { object: this.change(managerId, before, patch, by, why) }
    })
  }
  private answerFailure(decision: ManagerDecision, answer: ManagerSubmittedAnswer): string | null {
    if (decision.status !== 'open') return 'The decision is no longer open.'
    if (
      typeof answer.text !== 'string' ||
      (answer.optionId !== null && typeof answer.optionId !== 'string')
    )
      return 'Provide optionId (or null) and text.'
    if (
      answer.optionId !== null &&
      !decision.options.some((option) => option.id === answer.optionId)
    )
      return 'The chosen option does not exist.'
    if (answer.optionId === null && !answer.text.trim())
      return 'Choose an option or enter an answer.'
    return null
  }
  answers(managerId: string, given: unknown): ManagerAnswersSubmitResponse {
    this.active(managerId)
    if (!Array.isArray(given) || !given.length) invalid('answers must be a nonempty array.')
    const answers = given.map((value) => fields(value))
    for (const answer of answers)
      if (!/^D-[1-9][0-9]*$/.test(text(answer.decisionId, 'decisionId')))
        invalid('Invalid decisionId.')
    const counts = new Map<string, number>()
    for (const answer of answers)
      counts.set(String(answer.decisionId), (counts.get(String(answer.decisionId)) ?? 0) + 1)
    return this.store.transaction(() => {
      const result: ManagerAnswersSubmitResponse = { accepted: [], rejected: [], delivery: 'none' }
      for (const raw of answers) {
        const answer = raw as unknown as ManagerSubmittedAnswer
        const found = this.store.object(managerId, answer.decisionId)
        const decision = found && isDecision(found) ? found : null
        const code =
          counts.get(answer.decisionId) !== 1
            ? 'invalidAnswer'
            : !decision
              ? 'unknownDecision'
              : !Number.isSafeInteger(answer.revision) || answer.revision < 1
                ? 'invalidAnswer'
                : answer.revision !== decision.revision
                  ? 'decisionConflict'
                  : decision.status !== 'open'
                    ? 'decisionNotOpen'
                    : this.answerFailure(decision, answer)
                      ? 'invalidAnswer'
                      : null
        if (code || !decision) {
          result.rejected.push({
            decisionId: answer.decisionId,
            code: code ?? 'unknownDecision',
            message:
              code === 'decisionConflict'
                ? 'The decision changed; read it and confirm again.'
                : code === 'decisionNotOpen'
                  ? 'The decision is no longer open.'
                  : code === 'unknownDecision'
                    ? 'Unknown decision.'
                    : 'Invalid or duplicate answer; choose an existing option or enter text.',
            decision,
          })
          continue
        }
        result.accepted.push(
          this.change(
            managerId,
            decision,
            {
              status: 'answered',
              answer: {
                optionId: answer.optionId,
                text: answer.text,
                by: 'user',
                at: managerNow(),
              },
            },
            'user',
            'Board answer submitted',
          ) as ManagerDecision,
        )
      }
      if (result.accepted.length) {
        this.store.enqueue(
          managerId,
          formatSessionEvent({
            kind: 'manager-answers',
            notes: [],
            manager: {
              managerId,
              text: MANAGER_ANSWERS_TEXT,
              answers: result.accepted.map((decision) => ({
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
        )
        result.delivery = 'queued'
      }
      return result
    })
  }
  reopen(managerId: string, id: ManagerObjectId): ManagerDecision {
    this.active(managerId)
    const before = this.object(managerId, id)
    if (!isDecision(before) || !['expired', 'withdrawn'].includes(before.status))
      throw new ManagerError(
        'decisionNotClosed',
        'Only expired or withdrawn decisions can be reopened.',
      )
    return this.store.transaction(
      () =>
        this.change(
          managerId,
          before,
          { status: 'open', closed: null },
          'user',
          'Decision reopened',
        ) as ManagerDecision,
    )
  }
}
