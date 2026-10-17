// 只给测量用：在一台设备上一个接一个地建一批会话，量会话列表滑动流不流畅（litch://seed?count=300）。
// 走的是正式的 session.create，会话轮流归进这台设备的各个工作区和“无工作区”；只在模拟核心里用，
// 页面和正式的启动路径都不引用它。
import { type CoreChannel, type KeyedStore, keys, type WorkspaceView } from '@litch/core'

export async function seedSessions(
  channel: CoreChannel,
  store: KeyedStore,
  deviceId: string,
  count: number,
): Promise<void> {
  const workspaces = store.get<WorkspaceView[]>(keys.workspaces(deviceId)) ?? []
  for (let n = 1; n <= count; n++) {
    const workspace = workspaces[n % (workspaces.length + 1)]
    await channel.command('session.create', {
      deviceId,
      cwd: workspace?.roots[0] ?? null,
      ...(workspace ? { workspaceId: workspace.id } : {}),
      text: `seed ${String(n).padStart(3, '0')}`,
    })
  }
}
