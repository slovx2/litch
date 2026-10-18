// 父会话的子代理列表（按父会话问核心的 session.agents）。状态在 agents.ts
import type { AgentThreadView } from '@litch/core'
import { useEffect, useSyncExternalStore } from 'react'
import { useServices } from '../app/services.tsx'
import { ask, keyOf, lists, subscribe, versionNow } from './agents.ts'

/**
 * 父会话的子代理列表。stamp 变了（比如卡片上子代理的状态变了）就再问一次；
 * enabled 为假时不问，只给已经有的
 */
export function useAgentList(
  deviceId: string,
  parentId: string | null,
  stamp = '',
  enabled = true,
): AgentThreadView[] | null {
  const { channel } = useServices()
  useSyncExternalStore(subscribe, versionNow)
  useEffect(() => {
    if (parentId === null || !enabled) return
    ask(channel, deviceId, parentId, stamp !== '')
  }, [channel, deviceId, parentId, stamp, enabled])
  return parentId === null ? null : (lists.get(keyOf(deviceId, parentId))?.list ?? null)
}
