// 控制台本地草稿与议题现状的关系。草稿只在客户端（桌面 localStorage、手机文件），议题在别处
// 答复、关闭、忽略、撤回或取消后，草稿不删，但不再计数、不能随“提交给经理”发出；议题重新打开后自动回来。
import type { ManagerDecisionStatus, ManagerRequest } from '../../../protocol/src/manager.mjs'
import type { ManagerPostKind } from '../../../protocol/src/manager-posts.mjs'

/**
 * live：照常计数、可提交，revision 是提交时该带的版本；conflict：决策内容在写草稿之后改过，要先确认；
 * ended：议题已不待处理（决策已答复/关闭/忽略，请你做已取消，建议已处理，或对象没了）。
 */
export interface ManagerDraftState {
  state: 'live' | 'conflict' | 'ended'
  revision: number
}

export interface ManagerDraftBoard {
  decisions: readonly { id: string; status: ManagerDecisionStatus; revision: number }[]
  changes: readonly {
    objectId: string
    fields: readonly string[]
    after: Record<string, unknown> | null
  }[]
  requests?: readonly { id: string; status: ManagerRequest['status']; revision: number }[]
  posts?: readonly {
    id: string
    kind: ManagerPostKind
    revision: number
    fields: Record<string, unknown>
  }[]
}

/** 作答依据的字段：改了这些，草稿要先确认 */
const DECISION_CONTENT = ['title', 'background', 'options', 'recommend', 'default']

/**
 * 决策上的草稿（答案和追问）。版本一致照常；版本变了而决策已不待定是 ended。
 * 又回到待定的：中间只经过状态变化（答复、关闭、忽略、重开）而问题本身没改，草稿自动恢复、跟上当前版本；
 * 问题改过或从没离开待定的版本变化，沿用原来的“先确认”。
 */
export function decisionDraftState(
  board: ManagerDraftBoard,
  id: string,
  revision: number,
): ManagerDraftState {
  const decision = board.decisions.find((one) => one.id === id)
  if (!decision) return { state: 'ended', revision }
  if (decision.revision === revision) return { state: 'live', revision }
  if (decision.status !== 'open') return { state: 'ended', revision }
  const later = board.changes.filter(
    (change) =>
      change.objectId === id &&
      typeof change.after?.revision === 'number' &&
      change.after.revision > revision,
  )
  const reworded = later.some((change) =>
    change.fields.some((field) => DECISION_CONTENT.includes(field)),
  )
  const left = later.some((change) => change.after?.status !== 'open')
  return !reworded && left
    ? { state: 'live', revision: decision.revision }
    : { state: 'conflict', revision }
}

/**
 * 请你做的回复草稿，规则同决策：取消了是 ended；版本一致照常；版本变了而已不待办（在别处交付或回复）是 ended，
 * 还待办的沿用原来的“先确认”。
 */
export function requestDraftState(
  board: ManagerDraftBoard,
  id: string,
  revision: number,
): ManagerDraftState {
  const request = board.requests?.find((one) => one.id === id)
  if (!request || request.status === 'cancelled') return { state: 'ended', revision }
  if (request.revision === revision) return { state: 'live', revision }
  return { state: request.status === 'open' ? 'conflict' : 'ended', revision }
}

/** 议题上的追问草稿（请你做、报告、建议）：请你做取消、建议已处理是 ended；报告没有结束的状态 */
export function postDraftState(
  board: ManagerDraftBoard,
  id: string,
  revision: number,
): ManagerDraftState {
  const post = board.posts?.find((one) => one.id === id)
  if (!post) return { state: 'ended', revision }
  if (post.kind === 'decision') return decisionDraftState(board, id, revision)
  // 交付、回复过的请你做照样可以追问，取消了才算结束
  const request = board.requests?.find((one) => one.id === id)
  if (post.kind === 'request' && (!request || request.status === 'cancelled'))
    return { state: 'ended', revision }
  if (post.kind === 'suggestion' && post.fields.status !== 'pending')
    return { state: 'ended', revision }
  return { state: post.revision === revision ? 'live' : 'conflict', revision }
}

export interface ManagerDecisionDraft {
  decisionId: string
  revision: number
  optionId: string | null
  text: string
  question?: string
}
/** 仅选项的旧版本草稿直接清掉；自由文字（包括追问）要保留给用户核对。结束的草稿仍走 ended。 */
export function resetDecisionSelection(
  board: ManagerDraftBoard,
  draft: ManagerDecisionDraft,
): boolean {
  return (
    !draft.text.trim() &&
    !draft.question?.trim() &&
    decisionDraftState(board, draft.decisionId, draft.revision).state === 'conflict'
  )
}
export interface ManagerRequestDraft {
  requestId: string
  revision: number
  delivered: boolean
  text: string
}
export interface ManagerPostDraft {
  id: string
  revision: number
  question: string
}

/**
 * 控制台底部“N 项尚未提交”、侧栏“N 项草稿”和“提交给经理”只算还有效的草稿：去掉 ended 的，live 的换成提交时该带的版本。
 * 看板还没读到（board 为空）时全算，和以前一样。ended 列出各类草稿已结束的对象 id，卡片据此出提示。
 */
export function liveManagerDrafts<
  D extends ManagerDecisionDraft,
  R extends ManagerRequestDraft,
  P extends ManagerPostDraft,
>(
  board: ManagerDraftBoard | null | undefined,
  drafts: { decisions: readonly D[]; requests: readonly R[]; posts: readonly P[] },
) {
  const live: ManagerDraftState = { state: 'live', revision: 0 }
  const decisionState = (draft: D) =>
    board
      ? decisionDraftState(board, draft.decisionId, draft.revision)
      : { ...live, revision: draft.revision }
  const requestState = (draft: R) =>
    board
      ? requestDraftState(board, draft.requestId, draft.revision)
      : { ...live, revision: draft.revision }
  const postState = (draft: P) =>
    board ? postDraftState(board, draft.id, draft.revision) : { ...live, revision: draft.revision }
  const keep = <T extends { revision: number }>(
    list: readonly T[],
    state: (draft: T) => ManagerDraftState,
  ) =>
    list.flatMap((draft) => {
      const found = state(draft)
      return found.state === 'ended'
        ? []
        : [{ draft: { ...draft, revision: found.revision }, conflict: found.state === 'conflict' }]
    })
  const answered = keep(
    drafts.decisions.filter(
      (draft) =>
        (draft.optionId !== null || draft.text.trim()) &&
        !(board && resetDecisionSelection(board, draft)),
    ),
    decisionState,
  )
  const asked = keep(
    drafts.decisions.filter((draft) => draft.question?.trim()),
    decisionState,
  )
  const requests = keep(
    drafts.requests.filter((draft) => draft.delivered || draft.text.trim()),
    requestState,
  )
  const posts = keep(
    drafts.posts.filter((draft) => draft.question.trim()),
    postState,
  )
  return {
    answers: answered.map((entry) => entry.draft),
    questions: asked.map((entry) => entry.draft),
    requests: requests.map((entry) => entry.draft),
    posts: posts.map((entry) => entry.draft),
    /** 决策或议题追问里有要先确认的 */
    conflict: [...answered, ...asked, ...posts].some((entry) => entry.conflict),
    requestConflict: requests.some((entry) => entry.conflict),
    count:
      new Set([...answered, ...asked].map((entry) => entry.draft.decisionId)).size +
      requests.length +
      posts.length,
    ended: {
      decisions: new Set(
        drafts.decisions
          .filter(
            (draft) =>
              (draft.optionId !== null || draft.text.trim() || draft.question?.trim()) &&
              decisionState(draft).state === 'ended',
          )
          .map((draft) => draft.decisionId),
      ),
      requests: new Set(
        drafts.requests
          .filter(
            (draft) =>
              (draft.delivered || draft.text.trim()) && requestState(draft).state === 'ended',
          )
          .map((draft) => draft.requestId),
      ),
      posts: new Set(
        drafts.posts
          .filter((draft) => draft.question.trim() && postState(draft).state === 'ended')
          .map((draft) => draft.id),
      ),
    },
  }
}

/** 分页列表里的一张卡头：分页看板只带点开过的详情，其余对象的状态和版本只在卡头上 */
export interface ManagerDraftHead {
  id: string
  kind: string
  status: string
  revision: number
}

/**
 * 分页看板的草稿判断面：点开过的详情为准，没点开的用卡头补状态和版本（同一对象取版本最高的卡头）。
 * 不补的话，没点开过的决策上的草稿会被当成 ended，提交条少算、卡头也标不出来。
 */
export function pagedDraftBoard(
  board: ManagerDraftBoard,
  heads: Iterable<ManagerDraftHead>,
): ManagerDraftBoard {
  const latest = new Map<string, ManagerDraftHead>()
  for (const head of heads) {
    const found = latest.get(head.id)
    if (!found || head.revision > found.revision) latest.set(head.id, head)
  }
  const decisions = [...board.decisions]
  const requests = [...(board.requests ?? [])]
  const posts = [...(board.posts ?? [])]
  for (const head of latest.values()) {
    if (head.kind === 'decision' && !decisions.some((one) => one.id === head.id))
      decisions.push({
        id: head.id,
        status: head.status as ManagerDecisionStatus,
        revision: head.revision,
      })
    if (head.kind === 'request' && !requests.some((one) => one.id === head.id))
      requests.push({
        id: head.id,
        status: head.status as ManagerRequest['status'],
        revision: head.revision,
      })
    if (head.kind !== 'item' && !posts.some((one) => one.id === head.id))
      posts.push({
        id: head.id,
        kind: head.kind as ManagerPostKind,
        revision: head.revision,
        // 卡头把“经理未审核”的待开始建议写成 review，帖子字段里仍是 pending
        fields: { status: head.status === 'review' ? 'pending' : head.status },
      })
  }
  return { ...board, decisions, requests, posts }
}

/** 收起的卡头上要说的草稿：写了哪几样，以及还能不能提交 */
export interface ManagerDraftMark {
  state: ManagerDraftState['state']
  /** 选中的选项 id（决策） */
  optionId: string | null
  /** 写了补充说明或回复文字 */
  text: boolean
  /** 写了追问 */
  question: boolean
  /** 点了交付（请你做） */
  delivered: boolean
}

/** 一个对象上全部本地草稿合成一个卡头标记；什么都没写返回 null */
export function managerDraftMark(
  board: ManagerDraftBoard,
  id: string,
  drafts: {
    decision?: ManagerDecisionDraft | undefined
    request?: ManagerRequestDraft | undefined
    post?: ManagerPostDraft | undefined
  },
): ManagerDraftMark | null {
  const { decision, request, post } = drafts
  const mark: ManagerDraftMark = {
    state: 'live',
    optionId: decision?.optionId ?? null,
    text: Boolean(decision?.text.trim() || request?.text.trim()),
    question: Boolean(decision?.question?.trim() || post?.question.trim()),
    delivered: Boolean(request?.delivered),
  }
  if (!mark.optionId && !mark.text && !mark.question && !mark.delivered) return null
  const states = [
    decision ? decisionDraftState(board, id, decision.revision).state : null,
    request && (request.delivered || request.text.trim())
      ? requestDraftState(board, id, request.revision).state
      : null,
    post?.question.trim() ? postDraftState(board, id, post.revision).state : null,
  ].filter((state) => state !== null)
  // 有一样还能交就不算失效；要先确认的优先提示
  mark.state = states.includes('conflict') ? 'conflict' : states.includes('live') ? 'live' : 'ended'
  return mark
}
