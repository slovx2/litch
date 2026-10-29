// L0 的经理对象已定义；方法尚未登记到协议总入口，此处只组合已有类型。
import type {
  ManagerAnswersSubmitParams,
  ManagerAnswersSubmitResponse,
  ManagerBoardReadParams,
  ManagerBoardReadResponse,
  ManagerCreateParams,
  ManagerCreateResponse,
  ManagerDecisionReopenParams,
  ManagerDecisionReopenResponse,
  ManagerEndParams,
  ManagerEndResponse,
  ManagerListParams,
  ManagerListResponse,
  ManagerUpdateParams,
  ManagerUpdateResponse,
} from '../../../protocol/src/manager.mjs'

export interface ManagerRequests {
  'litch/manager/list': { params: ManagerListParams; result: ManagerListResponse }
  'litch/manager/create': { params: ManagerCreateParams; result: ManagerCreateResponse }
  'litch/manager/update': { params: ManagerUpdateParams; result: ManagerUpdateResponse }
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
}
