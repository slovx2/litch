import type { SessionCatalog, SessionKind, Text, WorkspaceView } from '@litch/core'
import type { SessionCandidate } from './session-hits.ts'

/** 两端候选使用同一全目录；仅应用既有的原生子会话可见性，不按经理身份过滤。 */
export function catalogCandidates(
  catalog: SessionCatalog,
  workspaces: readonly WorkspaceView[],
  titleOf: (text: Text) => string,
  kindOf: (kind: SessionKind) => string,
  hidden: ReadonlySet<string>,
): SessionCandidate[] {
  return catalog
    .filter((entry) => !hidden.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      title: titleOf(entry.title) || entry.id.slice(0, 8),
      typeLabel: kindOf(entry.kind),
      harness: entry.harness,
      workspace: workspaces.find((one) => one.id === entry.workspaceId)?.name ?? '',
      workspaceId: entry.workspaceId,
      cwd: entry.cwd,
      updatedAt: entry.updatedAt,
    }))
}
