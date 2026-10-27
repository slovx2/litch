// 对话区顶上那一条细的状态：设备没连上、或者核心的快照还没到（摆着的是上次留下的内容，或者什么都还没有）。
// 内容照常显示、照常能翻，这一条只是告诉人“这不一定是最新的”。
import type { ConnectionState } from '@litch/core'

export type SyncState = 'connecting' | 'offline' | 'loading' | null

/**
 * connection：设备的连接状态（设备的摘要还没到是 undefined）；loaded：核心给过这个会话的快照（meta 不是 null）；
 * failed：订阅报错了（错误另有一行，不再写“正在加载”）
 */
export function syncState(
  connection: ConnectionState | undefined,
  loaded: boolean,
  failed: boolean,
): SyncState {
  if (connection === 'connecting' || connection === 'reconnecting') return 'connecting'
  if (connection === 'offline' || connection === 'error') return 'offline'
  if (!loaded && !failed) return 'loading'
  return null
}
