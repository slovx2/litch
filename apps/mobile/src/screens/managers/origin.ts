// 工作线回到它的经理（35-manager 17.5）：页面栈里下面有这个经理页就退回到那一层（按 key 导航，中间的页面出栈，
// 它的对话和各页签的状态都还在），栈里没有就推一个落在“工作线”的经理页。纯函数，单测在 test/manager-workbench.test.mjs。
import type { ManagerRelation } from '../../../../../packages/protocol/src/manager-posts.mjs'
import { relationGroups } from '../../../../../packages/protocol/src/manager-relations.mts'

export interface StackRoute {
  key: string
  name: string
  params?: object | undefined
}

/** 栈里当前页下面最近的那个经理页（同一设备、同一经理）；没有是 null，要新推一个 */
export function managerRouteBelow(
  routes: readonly StackRoute[],
  index: number,
  deviceId: string,
  managerId: string,
): StackRoute | null {
  for (let at = index - 1; at >= 0; at--) {
    const route = routes[at]
    const params = route?.params as { deviceId?: unknown; managerId?: unknown } | undefined
    if (
      route?.name === 'ManagerConsole' &&
      params?.deviceId === deviceId &&
      params.managerId === managerId
    )
      return route
  }
  return null
}

/** 和这条线有关的议题编号（来源、派生、相关三组合在一起，去重，按出现先后） */
export function lineIssues(relations: readonly ManagerRelation[], threadId: string): string[] {
  const groups = relationGroups(relations, { kind: 'thread', target: threadId })
  const ids = [...groups.source, ...groups.derived, ...groups.related].flatMap((target) =>
    target.kind === 'issue' ? [target.target] : [],
  )
  return [...new Set(ids)]
}
