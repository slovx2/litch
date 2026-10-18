// 工作区：协议里的“项目”怎么变成界面里的工作区，以及一个会话归到哪个工作区。纯函数。
import type { Project, Thread } from '../../../protocol/src/index.mjs'
import type { WireColor, WorkspaceView } from '../model.mjs'
import { noTwin, type PathTwin } from '../text/paths.mjs'
import { WIRES } from './remote.mjs'

/**
 * 工作区的颜色记在项目的 metadata 里的哪个键上。协议里项目没有颜色这个字段，metadata 是给客户端自己放东西的；
 * 键带着我们的前缀，别的客户端看到了也不会当成自己的。能挑的颜色和设备的线色是同一组：界面上只有这一套色板
 */
export const COLOR_KEY = 'litch.color'

const isColor = (value: unknown): value is WireColor =>
  typeof value === 'string' && (WIRES as readonly string[]).includes(value)

export function projectWorkspace(project: Project): WorkspaceView {
  const color = project.metadata?.[COLOR_KEY]
  return {
    id: project.id,
    name: project.name,
    roots: (project.roots ?? []).map((root) => root.path),
    // 不认识的值（别的版本写的）当没挑过
    color: isColor(color) ? color : null,
  }
}

/** 设备上认得的绝对路径：以 / 开头，或者盘符加冒号再加斜杠。相对路径、~ 开头的对面一律不收 */
export const isAbsolutePath = (path: string): boolean => /^(\/|[A-Za-z]:[\\/])/.test(path)

/**
 * 改工作区的名字、颜色时要发的 metadata。协议里这一项是整份替换，所以要带着原来的别的键一起发
 * （导入时记下的来源之类）。颜色给 null 是去掉。没有要改的返回 undefined：请求里不带这一项
 */
export function colorPatch(
  project: Pick<Project, 'metadata'>,
  color: WireColor | null | undefined,
): Record<string, string> | undefined {
  if (color === undefined) return undefined
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(project.metadata ?? {})) {
    if (typeof value === 'string' && key !== COLOR_KEY) next[key] = value
  }
  if (color !== null) next[COLOR_KEY] = color
  return next
}

/** 按设备上定的顺序排 */
export function projectWorkspaces(projects: Project[]): WorkspaceView[] {
  return [...projects].sort((a, b) => a.position - b.position).map(projectWorkspace)
}

const trimSeparators = (path: string): string => path.replace(/[\\/]+$/, '')

/**
 * root 是不是 path 本身或它的上级目录。只在目录边界上算，/a/b 不是 /a/bc 的上级。
 * twin 给了路径的另一种写法（macOS 上 /private/var 和 /var 是一处，text/paths.mts 的 pathTwin）时也认
 */
function contains(root: string, path: string, twin: PathTwin): boolean {
  const base = trimSeparators(root)
  if (!base) return false
  const literal = (candidate: string): boolean => {
    if (candidate === base) return true
    if (!candidate.startsWith(base)) return false
    const next = candidate[base.length]
    return next === '/' || next === '\\'
  }
  if (literal(path)) return true
  const other = twin(path)
  return other !== null && literal(other)
}

/**
 * 会话归到哪个工作区：
 * 1. 会话上记了工作区，而且这个工作区还在，就用它；
 * 2. 否则找根目录是会话工作目录上级（或就是它）的工作区，命中多个时取最深的那个；
 *    一样深（同一个目录是好几个工作区的根）时照官方桌面端的优先规则：只有一个根的优先，
 *    其次是这个目录是它的主目录（第一个根）的，再其次按设备上排的先后
 *    （官方最后一条比的是建的先后；从 Codex 导入的工作区是按它的项目排的，差不多是一回事）；
 * 3. 都不命中就不属于任何工作区，返回 null。
 * 这是确定性的纯计算，结果不写回设备。twin 是这台设备上路径的另一种写法（见 contains）
 */
export function resolveWorkspace(
  thread: Pick<Thread, 'projectId' | 'cwd'>,
  workspaces: WorkspaceView[],
  twin: PathTwin = noTwin,
): string | null {
  if (thread.projectId && workspaces.some((workspace) => workspace.id === thread.projectId)) {
    return thread.projectId
  }
  const cwd = trimSeparators(thread.cwd ?? '')
  /** 越大越优先：先比深浅，再比是不是只有一个根，再比是不是主目录。一样大的留先遇到的 */
  let best: { id: string; rank: [number, number, number] } | null = null
  const better = (a: [number, number, number], b: [number, number, number]) =>
    a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]
  for (const workspace of workspaces) {
    for (const [at, root] of workspace.roots.entries()) {
      if (!contains(root, cwd, twin)) continue
      const rank: [number, number, number] = [
        trimSeparators(root).length,
        workspace.roots.length === 1 ? 1 : 0,
        at === 0 ? 1 : 0,
      ]
      if (!best || better(rank, best.rank)) best = { id: workspace.id, rank }
    }
  }
  return best?.id ?? null
}
