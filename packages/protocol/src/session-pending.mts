// sessionTree 的阻塞请求快照与代答记录。请求 token 只在当前设备进程/引擎连接有效。
export interface SessionPendingRequest {
  id: string
  threadId: string
  harness: string
  turnId: string | null
  kind: 'question' | 'approval' | 'form' | 'clientApproval' | 'unknown'
  title: string
  summary: string
  createdAt: number
  canRespond: boolean
  reason?: 'secret_requires_user' | 'executor_required' | 'unsupported_request'
  questions?: {
    id: string
    question: string
    options: string[]
    allowOther: boolean
  }[]
  decisions?: unknown[]
}

export interface SessionDelegatedResponse {
  id: string
  requestId: string
  threadId: string
  turnId: string | null
  sourceThreadId: string
  sourceTitle: string
  parent: boolean
  kind: SessionPendingRequest['kind']
  title: string
  answer: unknown
  questions?: { id: string; question: string }[]
  at: number
}

export interface SessionPendingFields {
  litchQuestionSettlements?: SessionQuestionSettlement[]
  litchIgnoredQuestions?: string[]
  litchPendingRequests?: SessionPendingRequest[]
  litchDelegatedResponses?: SessionDelegatedResponse[]
}

/** 按问题来源留痕；不会冒充用户答复，也不影响之后重新提出的同题。 */
export interface SessionQuestionSettlement {
  id: string
  questionId: string
  threadId: string
  sourceIds: string[]
  replyIds: string[]
  title: string
  action: 'answer' | 'withdraw'
  text: string
  sourceThreadId: string
  sourceTitle: string
  at: number
}

export interface SessionPendingChanged extends SessionPendingFields {
  threadId: string
}
