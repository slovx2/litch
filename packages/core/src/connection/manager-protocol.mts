// L0 的经理对象已定义；方法尚未登记到协议总入口，此处只组合已有类型。
import type {
  ManagerAnswersSubmitParams,
  ManagerAnswersSubmitResponse,
  ManagerBoardReadParams,
  ManagerBoardReadResponse,
  ManagerCreateParams,
  ManagerCreateResponse,
  ManagerDecisionIgnoreParams,
  ManagerDecisionIgnoreResponse,
  ManagerDecisionReopenParams,
  ManagerDecisionReopenResponse,
  ManagerDiscussion,
  ManagerEndParams,
  ManagerEndResponse,
  ManagerFeedbackSubmitParams,
  ManagerFeedbackSubmitResponse,
  ManagerListParams,
  ManagerListResponse,
  ManagerQuestionParams,
  ManagerUpdateParams,
  ManagerUpdateResponse,
} from '../../../protocol/src/manager.mjs'
import type { ManagerIssueRequests } from '../../../protocol/src/manager-issues.mjs'
import type { ManagerPagingRequests } from '../../../protocol/src/manager-paging.mjs'
export interface ManagerRequests extends ManagerPagingRequests, ManagerIssueRequests {
  'litch/manager/reference/read': {
    params: { managerId: string; reference: string }
    result: { text: string }
  }
  'litch/manager/post/forward': {
    params: {
      managerId: string
      id: import('../../../protocol/src/manager-posts.mjs').ManagerPostId
    }
    result: { queued: boolean }
  }
  'litch/manager/post/question': {
    params: import('../../../protocol/src/manager-posts.mjs').ManagerPostQuestionParams
    result: { post: import('../../../protocol/src/manager-posts.mjs').ManagerPost }
  }
  'litch/manager/report/read': {
    params: import('../../../protocol/src/manager-posts.mjs').ManagerReportReadParams
    result: { post: import('../../../protocol/src/manager-posts.mjs').ManagerPost }
  }
  'litch/manager/feedback/submit': {
    params: ManagerFeedbackSubmitParams
    result: ManagerFeedbackSubmitResponse
  }
  'litch/manager/question/ask': {
    params: ManagerQuestionParams
    result: { discussion: ManagerDiscussion }
  }
  'litch/manager/question/forward': {
    params: ManagerDecisionReopenParams
    result: { queued: boolean }
  }
  'litch/manager/list': { params: ManagerListParams; result: ManagerListResponse }
  'litch/manager/create': { params: ManagerCreateParams; result: ManagerCreateResponse }
  'litch/manager/update': { params: ManagerUpdateParams; result: ManagerUpdateResponse }
  'litch/manager/reset': {
    params: import('../../../protocol/src/manager.mjs').ManagerResetParams
    result: ManagerEndResponse
  }
  'litch/manager/reset/preview': {
    params: import('../../../protocol/src/manager.mjs').ManagerResetPreviewParams
    result: import('../../../protocol/src/manager.mjs').ManagerResetPreview
  }
  'litch/manager/reset/cancel': {
    params: import('../../../protocol/src/manager.mjs').ManagerResetCancelParams
    result: ManagerEndResponse
  }
  'litch/manager/end': { params: ManagerEndParams; result: ManagerEndResponse }
  'litch/manager/board/read': { params: ManagerBoardReadParams; result: ManagerBoardReadResponse }
  'litch/manager/answers/submit': {
    params: ManagerAnswersSubmitParams
    result: ManagerAnswersSubmitResponse
  }
  'litch/manager/decision/reopen': {
    params: ManagerDecisionReopenParams
    result: ManagerDecisionReopenResponse
  }
  'litch/manager/decision/ignore': {
    params: ManagerDecisionIgnoreParams
    result: ManagerDecisionIgnoreResponse
  }
}
