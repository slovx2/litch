// issue 过滤的状态分组：桌面和手机共用的纯函数。
// 各类型的具体状态并在一起太多、还随所选类型膨胀，界面上只给一套跨类型的分组（单选）；
// 只选了一种类型时，可以在分组下面再选该类型的一个具体状态（细分，默认收起）。
// 查询仍是 ManagerIssueFilter.statuses：分组展开成所选类型里属于它的那几个状态，设备照旧按 kinds × statuses 过滤。
// 同名状态在各类型里语义一致，所以一张状态 → 分组的表就够，不按类型分开。
import {
  MANAGER_ISSUE_KINDS,
  MANAGER_ISSUE_STATUSES,
  type ManagerIssueFilter,
  managerIssueKindFilter,
} from '../../../../core/src/projection/manager-issue-list.mts'
import type {
  ManagerIssueKind,
  ManagerIssueStatus,
} from '../../../../protocol/src/manager-issues.mts'

/** 四个基本分组：每个具体状态恰好属于其中一个 */
export type IssueStatusBase = 'todo' | 'doing' | 'done' | 'dropped'
/** 界面上的分组：四个基本分组，加“未完成”（待处理 + 进行中）和“全部” */
export type IssueStatusGroup = IssueStatusBase | 'unfinished' | 'all'

/**
 * 具体状态归到哪一组：
 * - 待处理 todo：等人动手的。普通 issue 开放、决策待答复、请你做待办、建议待开始、报告未读。
 * - 进行中 doing：已经有人在处理。普通 issue 进行中、受阻；建议待审核（经理在审，用户暂时不用管，
 *   建议页默认只列待开始也是这个缘故）。
 * - 已完成 done：普通 issue 已解决、已关闭；决策已答复；请你做已交付、已回复；建议已开始；报告已读。
 * - 已撤销 dropped：已过期、已撤回、已忽略、已驳回、已取消。
 */
export const ISSUE_STATUS_GROUP: Record<ManagerIssueStatus, IssueStatusBase> = {
  open: 'todo',
  endorsed: 'todo',
  unread: 'todo',
  in_progress: 'doing',
  blocked: 'doing',
  pending: 'doing',
  resolved: 'done',
  closed: 'done',
  answered: 'done',
  delivered: 'done',
  replied: 'done',
  started: 'done',
  read: 'done',
  expired: 'dropped',
  withdrawn: 'dropped',
  ignored: 'dropped',
  dismissed: 'dropped',
  cancelled: 'dropped',
}

/** 显示次序；“未完成”紧跟它包含的两组 */
export const ISSUE_STATUS_GROUPS: readonly IssueStatusGroup[] = [
  'todo',
  'doing',
  'unfinished',
  'done',
  'dropped',
  'all',
]

/** 默认分组：每个页签首次进入都只看待处理（等于核心给的各类默认状态） */
export const DEFAULT_ISSUE_STATUS_GROUP: IssueStatusGroup = 'todo'

const kindsOf = (kinds: readonly ManagerIssueKind[]) => (kinds.length ? kinds : MANAGER_ISSUE_KINDS)

const inGroup = (group: IssueStatusGroup, status: ManagerIssueStatus) =>
  group === 'all' ||
  (group === 'unfinished'
    ? ISSUE_STATUS_GROUP[status] === 'todo' || ISSUE_STATUS_GROUP[status] === 'doing'
    : ISSUE_STATUS_GROUP[status] === group)

/** 所选类型里属于这一组的具体状态（按类型次序去重）；“全部”是空数组（不限状态）。 */
export function issueGroupStatuses(
  group: IssueStatusGroup,
  kinds: readonly ManagerIssueKind[],
): ManagerIssueStatus[] {
  if (group === 'all') return []
  return [
    ...new Set(
      kindsOf(kinds).flatMap((kind) =>
        MANAGER_ISSUE_STATUSES[kind].filter((status) => inGroup(group, status)),
      ),
    ),
  ]
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((one) => b.includes(one))

/**
 * 所选类型下能选的分组：在这些类型里一个状态都没有的组不出（选了也只能是空列表）；
 * “未完成”和待处理或进行中一模一样时也不出（比如决策没有进行中），免得两个选项结果相同。
 * 最多六个，不随类型数量增加。
 */
export function issueStatusGroups(kinds: readonly ManagerIssueKind[]): IssueStatusGroup[] {
  const todo = issueGroupStatuses('todo', kinds)
  const doing = issueGroupStatuses('doing', kinds)
  return ISSUE_STATUS_GROUPS.filter((group) => {
    if (group === 'all') return true
    if (group === 'unfinished') return todo.length > 0 && doing.length > 0
    return issueGroupStatuses(group, kinds).length > 0
  })
}

/** 当前状态条件在界面上的样子：一个分组，加可选的一个具体状态（细分） */
export interface IssueStatusChoice {
  group: IssueStatusGroup
  detail: ManagerIssueStatus | null
}

/** 只选了一种类型时才有细分；全部类型或多选时为 null */
export function issueSingleKind(kinds: readonly ManagerIssueKind[]): ManagerIssueKind | null {
  return kinds.length === 1 ? (kinds[0] ?? null) : null
}

/**
 * 把条件里的 statuses 读成分组：空 = 全部；正好是某组的状态集合 = 那一组；
 * 只选了一种类型且只有一个该类型的状态 = 它所在的组加细分（编号定位、细分选择都是这样）。
 * 其他组合（旧版本记住的多个零散状态、和类型对不上的状态）读不出来，返回 null，由调用方回到默认。
 */
export function readIssueStatus(
  statuses: readonly ManagerIssueStatus[],
  kinds: readonly ManagerIssueKind[],
): IssueStatusChoice | null {
  if (!statuses.length) return { group: 'all', detail: null }
  // 先比较四个基本组，再比“未完成”：两者相同时（单一类型没有进行中）算待处理。
  for (const group of ['todo', 'doing', 'done', 'dropped', 'unfinished'] as const) {
    const own = issueGroupStatuses(group, kinds)
    if (own.length && sameSet(own, statuses)) return { group, detail: null }
  }
  const single = issueSingleKind(kinds)
  const status = statuses[0]
  if (single && statuses.length === 1 && status && MANAGER_ISSUE_STATUSES[single].includes(status))
    return { group: ISSUE_STATUS_GROUP[status], detail: status }
  return null
}

/**
 * 某个分组下可选的细分状态。只有一种类型、组里有两个以上状态时才有；
 * “全部”和“未完成”不给细分（后者的细分就是待处理、进行中两组本身）。
 */
export function issueStatusDetails(
  group: IssueStatusGroup,
  kinds: readonly ManagerIssueKind[],
): ManagerIssueStatus[] {
  const single = issueSingleKind(kinds)
  if (!single || group === 'all' || group === 'unfinished') return []
  const list = issueGroupStatuses(group, [single])
  return list.length > 1 ? list : []
}

/** 选一个分组：展开成所选类型里的状态，细分清掉 */
export function withIssueStatusGroup(
  filter: ManagerIssueFilter,
  group: IssueStatusGroup,
): ManagerIssueFilter {
  return { ...filter, statuses: issueGroupStatuses(group, filter.kinds) }
}

/** 选一个细分状态；detail 为 null 时回到整组 */
export function withIssueStatusDetail(
  filter: ManagerIssueFilter,
  group: IssueStatusGroup,
  detail: ManagerIssueStatus | null,
): ManagerIssueFilter {
  return { ...filter, statuses: detail ? [detail] : issueGroupStatuses(group, filter.kinds) }
}

/**
 * 换类型：保留当前分组，按新类型重新展开；新类型下没有这一组时回到默认分组。
 * 细分只在新类型仍是同一种、且有这个状态时保留。
 */
export function withIssueKinds(
  filter: ManagerIssueFilter,
  kinds: ManagerIssueKind[],
): ManagerIssueFilter {
  const choice = readIssueStatus(filter.statuses, filter.kinds) ?? {
    group: DEFAULT_ISSUE_STATUS_GROUP,
    detail: null,
  }
  const single = issueSingleKind(kinds)
  if (choice.detail && single && MANAGER_ISSUE_STATUSES[single].includes(choice.detail))
    return { ...filter, kinds, statuses: [choice.detail] }
  const group = issueStatusGroups(kinds).includes(choice.group)
    ? choice.group
    : DEFAULT_ISSUE_STATUS_GROUP
  return { ...filter, kinds, statuses: issueGroupStatuses(group, kinds) }
}

/** 类型多选里勾上或去掉一种；至少留一种（全去掉不生效） */
export function toggleIssueKind(
  filter: ManagerIssueFilter,
  kind: ManagerIssueKind,
): ManagerIssueFilter {
  const selected = filter.kinds.length ? filter.kinds : [...MANAGER_ISSUE_KINDS]
  const next = selected.includes(kind)
    ? selected.filter((one) => one !== kind)
    : MANAGER_ISSUE_KINDS.filter((one) => one === kind || selected.includes(one))
  if (!next.length) return filter
  return withIssueKinds(filter, next.length === MANAGER_ISSUE_KINDS.length ? [] : next)
}

/** 类型是否勾上；kinds 为空表示全部类型都勾上 */
export function issueKindChecked(filter: ManagerIssueFilter, kind: ManagerIssueKind): boolean {
  return !filter.kinds.length || filter.kinds.includes(kind)
}

/**
 * 读条件时的回退：状态读不成分组的（旧版本记住的零散状态组合）回到默认分组。
 * 读得出来时原样返回同一个对象，不打断依赖它的查询。
 */
export function normalizeIssueFilter(filter: ManagerIssueFilter): ManagerIssueFilter {
  if (readIssueStatus(filter.statuses, filter.kinds)) return filter
  return { ...filter, statuses: issueGroupStatuses(DEFAULT_ISSUE_STATUS_GROUP, filter.kinds) }
}

/**
 * 相对页签默认条件生效了几项筛选（排序不算）：类型、状态、创建者、跟进、未读各算一项。
 * 窄屏的“筛选”按钮上显示这个数，为 0 时不显示“清除筛选”。
 */
export function issueActiveFilterCount(filter: ManagerIssueFilter, tab: ManagerIssueKind): number {
  const base = managerIssueKindFilter(tab)
  const kinds = (list: readonly ManagerIssueKind[]) => (list.length ? list : MANAGER_ISSUE_KINDS)
  const choice = readIssueStatus(filter.statuses, filter.kinds)
  return [
    !sameSet(kinds(filter.kinds), kinds(base.kinds)),
    !choice || choice.group !== DEFAULT_ISSUE_STATUS_GROUP || choice.detail !== null,
    filter.authors.length > 0,
    filter.followUp !== 'all',
    filter.unread,
  ].filter(Boolean).length
}

/** 清除筛选：回到页签的默认条件，保留排序 */
export function clearIssueFilter(
  filter: ManagerIssueFilter,
  tab: ManagerIssueKind,
): ManagerIssueFilter {
  return { ...managerIssueKindFilter(tab), order: filter.order }
}
