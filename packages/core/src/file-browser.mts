/** 仅本次运行的浏览位置；会话互不继承，无会话时按项目隔离。 */
export const fileBrowserKey = (
  deviceId: string,
  sessionId: string | null | undefined,
  workspaceId: string | null = null,
): string =>
  JSON.stringify([deviceId, sessionId ? ['session', sessionId] : ['workspace', workspaceId]])

const positions = new Map<string, { root: string; linkPath?: string }>()
const listeners = new Set<() => void>()
let version = 0
export const fileBrowserVersion = () => version
export const fileBrowserRoot = (key: string, defaultRoot: string | null): string | null =>
  positions.get(key)?.root ?? defaultRoot
export const fileBrowserLink = (key: string): string | null => positions.get(key)?.linkPath ?? null
export function setFileBrowserRoot(key: string, path: string, linkPath?: string): void {
  const root = path
  if (positions.get(key)?.root === root && positions.get(key)?.linkPath === linkPath) return
  positions.delete(key)
  positions.set(key, { root, ...(linkPath ? { linkPath } : {}) })
  while (positions.size > 200) {
    const oldest = positions.keys().next().value
    if (oldest !== undefined) positions.delete(oldest)
  }
  version++
  for (const listener of listeners) listener()
}
export function subscribeFileBrowser(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
