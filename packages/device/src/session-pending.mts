// 只登记设备自有连接收到的原请求；模型只拿安全快照，答案沿原连接送回。

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { SessionPendingRequest } from '../../protocol/src/session-pending.mjs'
import type { EngineLink } from './engine-link.mjs'
import { isObject, type RpcId } from './wire.mjs'

/** 给模型的回报摘要不依赖界面语言；标题为空时仍明确说明请求类型。 */
export function pendingRequestExcerpt(
  request: Pick<SessionPendingRequest, 'kind' | 'title'>,
): string {
  if (request.title.trim()) return request.title.trim()
  switch (request.kind) {
    case 'clientApproval':
      return 'Browser sign-in'
    case 'question':
      return 'Question'
    case 'approval':
      return 'Approval'
    case 'form':
      return 'Form input'
    default:
      return 'Pending request'
  }
}

export class PendingRefused extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const short = (value: unknown): string => text(value).slice(0, 4000)
const same = isDeepStrictEqual
/** 执行中的客户端工具不是待用户请求；是否需要批准由客户端另行上报。 */
export const isUserRequest = (method: string): boolean =>
  [
    'item/tool/requestUserInput',
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'mcpServer/elicitation/request',
  ].includes(method)
const secret = (value: unknown): boolean => {
  if (!isObject(value)) return false
  if (
    value.isSecret === true ||
    value.secret === true ||
    value.writeOnly === true ||
    value.format === 'password' ||
    value.type === 'password'
  )
    return true
  return Object.entries(value).some(
    ([key, entry]) =>
      (entry !== false &&
        entry != null &&
        /password|passwd|one.?time|otp|credential|api.?key|access.?token|secret/i.test(key)) ||
      (Array.isArray(entry) ? entry.some(secret) : secret(entry)),
  )
}

interface Held {
  snapshot: SessionPendingRequest
  method: string
  params: Record<string, unknown>
  rpcId: RpcId
  link: EngineLink
}

export class SessionPending {
  private readonly requests = new Map<string, Held>()
  private readonly changed: (threadId: string) => void
  constructor(changed: (threadId: string) => void) {
    this.changed = changed
  }

  add(
    harness: string,
    link: EngineLink,
    method: string,
    params: Record<string, unknown>,
    rpcId: RpcId,
  ): void {
    if (!isUserRequest(method) || typeof params.threadId !== 'string') return
    // 同一连接重发幂等；数字 1 和字符串 "1" 是不同的 RPC ID。
    if ([...this.requests.values()].some((r) => r.link === link && r.rpcId === rpcId)) return
    const questions = Array.isArray(params.questions) ? params.questions.filter(isObject) : []
    const kind =
      method === 'item/tool/requestUserInput'
        ? 'question'
        : [
              'item/commandExecution/requestApproval',
              'item/fileChange/requestApproval',
              'item/permissions/requestApproval',
            ].includes(method)
          ? 'approval'
          : method === 'mcpServer/elicitation/request'
            ? 'form'
            : 'unknown'
    const sensitive = secret(params)
    const canRespond = !sensitive && (kind === 'question' || kind === 'approval')
    const snapshot: SessionPendingRequest = {
      id: randomUUID(),
      threadId: params.threadId,
      harness,
      turnId: typeof params.turnId === 'string' ? params.turnId : null,
      kind,
      title:
        kind === 'question'
          ? short(questions[0]?.question).trim() || 'Question / 待答问题'
          : short(params.reason).trim() ||
            (method === 'item/commandExecution/requestApproval'
              ? 'Command approval'
              : method === 'item/fileChange/requestApproval'
                ? 'File changes'
                : method === 'item/permissions/requestApproval'
                  ? 'Additional permissions'
                  : kind === 'form'
                    ? 'Form input'
                    : 'User action required'),
      summary: sensitive
        ? ''
        : kind === 'approval'
          ? [
              short(params.command),
              short(params.cwd),
              short(params.grantRoot),
              short(params.reason),
              method === 'item/permissions/requestApproval'
                ? JSON.stringify(params.permissions).slice(0, 4000)
                : '',
            ]
              .filter(Boolean)
              .join('\n')
          : kind === 'form'
            ? short(params.message)
            : '',
      createdAt: Date.now(),
      canRespond,
      ...(!canRespond
        ? {
            reason: sensitive
              ? ('secret_requires_user' as const)
              : kind === 'form'
                ? ('executor_required' as const)
                : ('unsupported_request' as const),
          }
        : {}),
      ...(kind === 'question' && !sensitive
        ? {
            questions: questions.map((q) => ({
              id: text(q.id),
              question: text(q.question),
              options: (Array.isArray(q.options) ? q.options : [])
                .filter(isObject)
                .map((o) => text(o.label)),
              allowOther: q.isOther === true || !Array.isArray(q.options) || q.options.length === 0,
            })),
          }
        : {}),
      ...(kind === 'approval' && !sensitive
        ? {
            decisions:
              method === 'item/permissions/requestApproval'
                ? ['accept', 'acceptForSession', 'decline']
                : Array.isArray(params.availableDecisions)
                  ? params.availableDecisions.filter((decision) => decision !== 'declineWithNote')
                  : ['accept', 'acceptForSession', 'decline', 'cancel'],
          }
        : {}),
    }
    if (!sensitive && !snapshot.summary) snapshot.summary = snapshot.title
    this.requests.set(snapshot.id, { snapshot, method, params, rpcId, link })
    this.changed(snapshot.threadId)
  }

  list(threadId: string): SessionPendingRequest[] {
    return [...this.requests.values()]
      .filter((r) => r.snapshot.threadId === threadId)
      .map((r) => structuredClone(r.snapshot))
  }

  resolve(link: EngineLink, rpcId: RpcId): void {
    this.remove((r) => r.link === link && r.rpcId === rpcId)
  }
  /** 用户从另一条客户端连接答了：发送前先撤销可代答 token，不等引擎广播 resolved。 */
  clientAnswered(harness: string, threadId: string, rpcId: RpcId): void {
    this.remove(
      (r) =>
        r.snapshot.harness === harness && r.snapshot.threadId === threadId && r.rpcId === rpcId,
    )
  }
  closed(link: EngineLink): void {
    this.remove((r) => r.link === link)
  }
  ended(threadId: string, turnId?: string): void {
    this.remove(
      (r) =>
        r.snapshot.threadId === threadId &&
        (!turnId || r.snapshot.turnId === null || r.snapshot.turnId === turnId),
    )
  }
  private remove(match: (request: Held) => boolean): void {
    const changed = new Set<string>()
    for (const [id, request] of this.requests)
      if (match(request)) {
        this.requests.delete(id)
        changed.add(request.snapshot.threadId)
      }
    for (const id of changed) this.changed(id)
  }

  respond(threadId: string, id: string, answer: unknown): SessionPendingRequest {
    const request = this.requests.get(id)
    if (!request || request.link.closed)
      throw new PendingRefused(
        'request_expired',
        'This request has expired or was already answered.',
      )
    const { snapshot } = request
    if (snapshot.threadId !== threadId)
      throw new PendingRefused('request_mismatch', 'The request belongs to another session.')
    if (!snapshot.canRespond)
      throw new PendingRefused(
        snapshot.reason ?? 'unsupported_request',
        'This request must be handled by the user in its original session.',
      )
    if (!isObject(answer) || JSON.stringify(answer).length > 32000)
      throw new PendingRefused('invalid_answer', 'answer must be an object.')
    let response: unknown
    if (snapshot.kind === 'approval') {
      if (
        Object.keys(answer).some((k) => k !== 'decision') ||
        !snapshot.decisions?.some((d) => same(d, answer.decision))
      )
        throw new PendingRefused('invalid_answer', 'Choose a decision returned by read.')
      response =
        request.method === 'item/permissions/requestApproval'
          ? {
              permissions: answer.decision === 'decline' ? {} : request.params.permissions,
              scope: answer.decision === 'acceptForSession' ? 'session' : 'turn',
            }
          : { decision: answer.decision }
    } else {
      const given = answer.answers
      const questions = snapshot.questions ?? []
      if (
        Object.keys(answer).some((k) => k !== 'answers') ||
        !isObject(given) ||
        questions.length === 0 ||
        Object.keys(given).some((id) => !questions.some((q) => q.id === id))
      )
        throw new PendingRefused(
          'invalid_answer',
          'Provide answers for the question IDs returned by read.',
        )
      const answers: Record<string, { answers: string[] }> = {}
      for (const question of questions) {
        const values = given[question.id]
        if (
          !Array.isArray(values) ||
          !values.every(
            (v) =>
              typeof v === 'string' &&
              v.length <= 32000 &&
              (question.allowOther || question.options.includes(v)),
          )
        )
          throw new PendingRefused('invalid_answer', `Invalid answer for ${question.id}.`)
        answers[question.id] = { answers: values }
      }
      response = { answers }
    }
    // 校验后同步占用并写原连接，期间不 await，其他答复不能重复取得同一 token。
    this.requests.delete(id)
    if (!request.link.answer(request.rpcId, response)) {
      this.changed(threadId)
      throw new PendingRefused('request_expired', 'The original request connection closed.')
    }
    this.changed(threadId)
    return snapshot
  }
}
