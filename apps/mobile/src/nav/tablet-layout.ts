// 与桌面侧栏相同的让位原则：侧栏至少 240，正文至少 600；工具打开且空间足够时才出现第三栏。
export const TABLET_SPLIT = 840
export const TABLET_TOOLS = 1280
export type Pane = 'navigation' | 'content' | 'tool'
export interface LayoutRoute {
  key: string
  name: string
}
export function navigationRoute(name: string): boolean {
  return name === 'Devices' || name === 'Sessions' || name === 'Managers'
}
export function toolRoute(name: string): boolean {
  return ['Terminal', 'Files', 'Diff', 'Background', 'Proposals', 'Agent'].includes(name)
}
export function tabletLayout(width: number, routes: readonly LayoutRoute[], index: number) {
  const split = width >= TABLET_SPLIT
  const sidebar = split ? Math.min(300, width - 600) : 0
  const shown = routes.slice(0, index + 1)
  const current = shown.at(-1)
  const navigation = shown.findLast((route) => navigationRoute(route.name))
  const content = shown.findLast((route) => !navigationRoute(route.name))
  const conversation = shown.findLast((route) => ['Detail', 'ManagerConsole'].includes(route.name))
  const third = split && width >= TABLET_TOOLS && content && toolRoute(content.name) && conversation
  const panes: Partial<Record<Pane, string>> = split
    ? {
        navigation: navigation?.key,
        content: third ? conversation.key : content?.key,
        ...(third ? { tool: content.key } : {}),
      }
    : { content: current?.key }
  return { split, sidebar, tool: third ? 380 : 0, panes }
}

/** 宽屏目录操作只切左栏；将目录路由放在内容前面，返回工具时仍回到当前对话。 */
export function orderTabletRoutes<T extends LayoutRoute>(routes: readonly T[]): T[] {
  return [
    ...routes.filter((route) => navigationRoute(route.name)),
    ...routes.filter((route) => !navigationRoute(route.name)),
  ]
}
