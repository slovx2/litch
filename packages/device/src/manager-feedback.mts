// 混合提交在一个事务里保存，只有成功项进入同一条经理事件，失败草稿留在客户端。
import { randomUUID } from 'node:crypto'
import { MANAGER_ANSWERS_TEXT } from '../../protocol/src/client-tools-manager.mjs'
import type {
  ManagerFeedbackSubmitResponse,
  ManagerSubmittedQuestion,
} from '../../protocol/src/manager.mjs'
import { formatSessionEvent } from '../../protocol/src/session-tree.mjs'
import { isDecision, type ManagerBoardWriter } from './manager-board.mjs'
import { submitRequests } from './manager-requests.mjs'
import { managerNow } from './manager-store.mjs'
import { fields, invalid, keys } from './manager-validate.mjs'

export function submitManagerFeedback(
  writer: ManagerBoardWriter,
  managerId: string,
  answers: unknown,
  questions: unknown,
  requests: unknown = [],
): ManagerFeedbackSubmitResponse {
  writer.active(managerId)
  if (
    !Array.isArray(answers) ||
    !Array.isArray(questions) ||
    !Array.isArray(requests) ||
    (!answers.length && !questions.length && !requests.length)
  )
    invalid('Provide answers, questions or requests with at least one entry.')
  const entries = questions.map((value) => {
    const entry = fields(value)
    keys(entry, ['decisionId', 'revision', 'question'])
    if (typeof entry.decisionId !== 'string' || !/^D-[1-9]\d*$/.test(entry.decisionId))
      invalid('Invalid decisionId.')
    return entry as unknown as ManagerSubmittedQuestion
  })
  const store = writer.store
  return store.transaction(() => {
    const result: ManagerFeedbackSubmitResponse = {
      accepted: [],
      rejected: [],
      acceptedQuestions: [],
      rejectedQuestions: [],
      acceptedRequests: [],
      rejectedRequests: [],
      delivery: 'none',
    }
    for (const entry of entries) {
      const object = store.object(managerId, entry.decisionId)
      const decision = object && isDecision(object) ? object : null
      const existing = store.question(managerId, entry.decisionId)
      const code = !decision
        ? 'unknownDecision'
        : entry.revision !== decision.revision
          ? 'decisionConflict'
          : !Number.isSafeInteger(entry.revision) ||
              typeof entry.question !== 'string' ||
              !entry.question.trim() ||
              entry.question.length > 20000 ||
              entries.filter((one) => one.decisionId === entry.decisionId).length !== 1 ||
              existing?.discussion.messages.some(
                (one) => one.status === 'running' && one.mode !== 'manager',
              )
            ? 'invalidAnswer'
            : null
      if (code || !decision) {
        result.rejectedQuestions.push({
          decisionId: entry.decisionId,
          code: code ?? 'unknownDecision',
          message:
            'The decision changed or the question is invalid; review it before submitting again.',
          decision,
        })
        continue
      }
      const state = existing ?? {
        managerId,
        decisionId: decision.id,
        threadId: null,
        threads: [],
        source: '',
        revision: 0,
        discussion: { messages: [], light: false, summary: null, forwarded: 0 },
      }
      state.discussion.messages.push({
        id: randomUUID(),
        mode: 'manager',
        question: entry.question.trim(),
        answer: null,
        status: 'running',
        refreshed: false,
        at: managerNow(),
      })
      state.discussion.summary = null
      store.saveQuestion(state)
      result.acceptedQuestions.push({ ...decision, discussion: state.discussion })
    }
    if (answers.length) Object.assign(result, writer.answers(managerId, answers, false))
    result.acceptedQuestions = result.acceptedQuestions.map((decision) => {
      const before = store.object(managerId, decision.id)
      if (!before || !isDecision(before) || !decision.discussion)
        invalid('The submitted question lost its decision.')
      const after = {
        ...before,
        discussion: decision.discussion,
        revision: before.revision + 1,
        updatedAt: managerNow(),
      }
      store.saveObject(managerId, after)
      store.record(
        managerId,
        decision.id,
        'user',
        before,
        after,
        'User submitted a question to the manager',
      )
      return after
    })
    Object.assign(result, submitRequests(store, managerId, requests))
    if (
      result.accepted.length ||
      result.acceptedQuestions.length ||
      result.acceptedRequests.length
    ) {
      store.enqueue(
        managerId,
        formatSessionEvent({
          kind: 'manager-answers',
          notes: [],
          manager: {
            managerId,
            text: `${MANAGER_ANSWERS_TEXT}\nAnswer follow-up questions in the main conversation and call litch_manager.reply with the decision id, current revision and text to save each reply. Questions are not decision answers or authorization to act.`,
            requests: result.acceptedRequests.map((request) => {
              if (!request.response) invalid('A submitted request must have a response.')
              return {
                requestId: request.id,
                revision: request.revision,
                title: request.title,
                buttonLabel: request.buttonLabel,
                delivered: request.response.delivered,
                text: request.response.text,
              }
            }),
            answers: result.accepted.map((decision) => ({
              decisionId: decision.id,
              title: decision.title,
              optionId: decision.answer?.optionId ?? null,
              optionLabel:
                decision.options.find((option) => option.id === decision.answer?.optionId)?.label ??
                null,
              text: decision.answer?.text ?? '',
              ...(decision.discussion ? { discussion: decision.discussion } : {}),
            })),
            questions: result.acceptedQuestions.map((decision) => {
              const entry = entries.find((entry) => entry.decisionId === decision.id)
              if (!entry) invalid('The submitted question is missing.')
              return {
                decisionId: decision.id,
                revision: store.object(managerId, decision.id)?.revision ?? decision.revision,
                title: decision.title,
                question: entry.question,
              }
            }),
          },
        }),
      )
      result.delivery = 'queued'
    }
    return result
  })
}
