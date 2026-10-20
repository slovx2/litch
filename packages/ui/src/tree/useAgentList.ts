// 父会话的子代理列表。父会话开着的时候以核心推来的为准（keys.agents，跟着子线程的回合变）；
// 第一次要的时候问一次核心的 session.agents（它顺带把列表交给开着的父会话），没开着的父会话（信息卡）只有问来的。
// 问来的那一份在 agents.ts
import { type AgentThreadView, keys } from '@litch/core'
import { useEffect, useSyncExternalStore } from 'react'
import { useKey, useServices } from '../app/services.tsx'
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
  const pushed = useKey<AgentThreadView[]>(keys.agents(deviceId, parentId ?? ''))
  useEffect(() => {
    if (parentId === null || !enabled) return
    ask(channel, deviceId, parentId, stamp !== '')
  }, [channel, deviceId, parentId, stamp, enabled])
  if (parentId === null) return null
  // 推来的是空的、问来的有：会话快照早于设备第一次列出子代理（之后会推来）
  if (pushed && (pushed.length > 0 || !lists.has(keyOf(deviceId, parentId)))) return pushed
  return lists.get(keyOf(deviceId, parentId))?.list ?? pushed ?? null
}
