import type { SessionCatalog, SessionKind, Text } from '@litch/core'

/** 目标只受设备未归档目录限制；类型用于显示和搜索，不限制经理或工作线。 */
export function sessionTargetOptions(
  catalog: SessionCatalog,
  titleOf: (text: Text) => string,
  kindOf: (kind: SessionKind) => string,
  harnessName: (harness: string) => string,
  showDirectory = false,
): { id: string; title: string; note: string }[] {
  return catalog.map((entry) => ({
    id: entry.id,
    title: titleOf(entry.title),
    note: [kindOf(entry.kind), harnessName(entry.harness), showDirectory ? entry.cwd : '']
      .filter(Boolean)
      .join(' · '),
  }))
}
