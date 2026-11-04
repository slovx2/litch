import type { HarnessVersionView, HarnessView } from '@litch/core'

/** 安装列表用最新探测，使用标记始终跟随运行实例；改设置不能冒充已经切换。 */
export function cliPresentation(
  running: HarnessView['cli'],
  installed: HarnessVersionView['candidates'],
) {
  const candidates = installed ?? running?.candidates ?? []
  if (!running) return { selected: candidates.find((entry) => entry.selected), candidates }
  const aliases = new Set([
    running.path,
    ...(running.candidates ?? []).filter((entry) => entry.selected).map((entry) => entry.path),
  ])
  const copies = candidates.map((entry) => ({ ...entry, selected: aliases.has(entry.path) }))
  // 运行后文件被移走，也保留进程真实使用的快照，不把另一份标成正在使用。
  if (!copies.some((entry) => entry.selected)) {
    copies.push({ path: running.path, version: running.version, selected: true })
  }
  return { selected: running, candidates: copies }
}
