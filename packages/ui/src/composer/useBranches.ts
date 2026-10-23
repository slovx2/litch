// 新建页问工作区根所在仓库的分支（worktree.branches），给“在哪做”“从哪切”用。
import type { DeviceView, WorktreeBranchesView } from '@litch/core'
import { useEffect, useState } from 'react'
import { useServices } from '../app/services.tsx'

/**
 * 工作区根的分支：设备能建工作树、有工作区根时才问。还在问是 undefined，不是 git 仓库（或者问不到）是 null
 */
export function useBranches(
  device: DeviceView | undefined,
  cwd: string | null,
): WorktreeBranchesView | null | undefined {
  const { channel } = useServices()
  const deviceId = device?.id ?? ''
  const able = device?.worktrees === true && device.connection === 'online' && cwd !== null
  const [found, setFound] = useState<{ key: string; branches: WorktreeBranchesView | null }>()
  const key = `${deviceId}\u0000${cwd ?? ''}`
  useEffect(() => {
    if (!able || cwd === null) return
    let live = true
    channel
      .command('worktree.branches', { deviceId, cwd })
      .then(
        ({ branches }) => branches,
        () => null,
      )
      .then((branches) => {
        if (live) setFound({ key, branches })
      })
    return () => {
      live = false
    }
  }, [channel, able, deviceId, cwd, key])
  if (!able) return null
  return found?.key === key ? found.branches : undefined
}
