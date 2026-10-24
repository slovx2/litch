// 新建页问工作区根的分支（worktree.branches）：和桌面 composer/useBranches.ts 一样，只是换成手机的通道。
import type { DeviceView, WorktreeBranchesView } from '@litch/core'
import { useEffect, useState } from 'react'
import { useChannel } from '../../shell/services'

/** 工作区根的分支：设备能建工作树、有工作区根时才问。还在问是 undefined，不是 git 仓库（或者问不到）是 null */
export function useBranches(
  device: DeviceView | undefined,
  cwd: string | null,
): WorktreeBranchesView | null | undefined {
  const channel = useChannel()
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
