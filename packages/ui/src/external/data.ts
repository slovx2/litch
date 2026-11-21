// 无人值守的数据入口：界面只经这里订阅核心的 externalDevice / externalInbox / externalOutbox /
// externalIdentityLogin 主题。本机和远程设备走同一条通道，核心负责断线保留与重连重读。
import {
  type ExternalDeviceView,
  type ExternalIdentity,
  type ExternalIdentityLoginView,
  type ExternalIdentityRepository,
  type ExternalInboxFilter,
  type ExternalInboxView,
  type ExternalOutboxFilter,
  type ExternalOutboxView,
  keys,
} from '@litch/core'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useKey, useKeys, useServices } from '../app/services.tsx'

type Topic =
  | { kind: 'externalDevice'; deviceId: string }
  | { kind: 'externalIdentityLogin'; deviceId: string; loginId: string }
  | { kind: 'externalInbox'; deviceId: string; filter: ExternalInboxFilter }
  | { kind: 'externalOutbox'; deviceId: string; filter: ExternalOutboxFilter }

/** 经理的选择项：ID 与名字 */
export interface ManagerChoice {
  id: string
  name: string
}

/** 订一个主题，取最新快照；enabled 为 false 时不订 */
function useTopic<T>(topic: Topic | null): T | undefined {
  const { channel } = useServices()
  const [value, setValue] = useState<T>()
  const key = topic ? JSON.stringify(topic) : ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: 主题按内容比较
  useEffect(() => {
    setValue(undefined)
    if (!topic) return
    return channel.subscribe(topic as never, {
      snapshot: (data: unknown) => setValue(data as T),
      delta: () => {},
      error: () => setValue(undefined),
    })
  }, [channel, key])
  return value
}

export function useExternalDevice(deviceId: string, enabled = true) {
  return useTopic<ExternalDeviceView>(enabled ? { kind: 'externalDevice', deviceId } : null)
}

export function useExternalInbox(deviceId: string, filter: ExternalInboxFilter, enabled = true) {
  return useTopic<ExternalInboxView>(enabled ? { kind: 'externalInbox', deviceId, filter } : null)
}

export function useExternalOutbox(deviceId: string, filter: ExternalOutboxFilter, enabled = true) {
  return useTopic<ExternalOutboxView>(enabled ? { kind: 'externalOutbox', deviceId, filter } : null)
}

export function useIdentityLogin(deviceId: string, loginId: string | null) {
  return useTopic<ExternalIdentityLoginView>(
    loginId ? { kind: 'externalIdentityLogin', deviceId, loginId } : null,
  )
}

/** 一次命令的忙与错：run 返回结果，失败时记下原因并返回 undefined */
export function useRun() {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = useCallback(
    async <R>(request: () => Promise<R>): Promise<R | undefined> => {
      setBusy(true)
      setError('')
      try {
        return await request()
      } catch (cause) {
        setError(reasonOf(cause, t))
        return undefined
      } finally {
        setBusy(false)
      }
    },
    [t],
  )
  return useMemo(() => ({ busy, error, run, setError }), [busy, error, run])
}

/** GitHub 头像：经桌面桥按数字 ID 取，取不到就是 null（画首字母） */
export function useAvatar(userId: string | undefined): string | null {
  const { channel } = useServices()
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    setSrc(null)
    if (!userId) return
    let live = true
    channel
      .command('external.identity.avatar', { userId })
      .then((data) => {
        if (live) setSrc(data)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [channel, userId])
  return src
}

/** 这台设备上在用的经理（选身份、标签路由用） */
export function useDeviceManagers(deviceId: string): ManagerChoice[] {
  const ids = useKey<readonly string[]>(keys.managerIds(deviceId)) ?? []
  const views = useKeys<ManagerView>(ids.map((id) => keys.manager(deviceId, id)))
  return useMemo(
    () =>
      views.flatMap((one) =>
        one && one.status === 'active' ? [{ id: one.id, name: one.name }] : [],
      ),
    [views],
  )
}

/** 身份的凭据明细与各身份能访问的仓库：配置版本变了重读 */
export function useIdentityDetails(deviceId: string, revision: number | null, canRead: boolean) {
  const { channel } = useServices()
  const t = useT()
  const [identities, setIdentities] = useState<ExternalIdentity[] | null>(null)
  const [repositories, setRepositories] = useState<ExternalIdentityRepository[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    if (!canRead) {
      setIdentities(null)
      setRepositories([])
      setError('')
      return
    }
    if (revision === null) return
    let live = true
    const load = async () => {
      try {
        const list = await channel.command('external.identity.list', { deviceId })
        if (!live) return
        setIdentities(list.identities)
        const all: ExternalIdentityRepository[] = []
        let cursor: string | null = null
        // 仓库授权分页读完；设备给不透明游标
        for (let page = 0; page < 20; page++) {
          const result: { repositories: ExternalIdentityRepository[]; nextCursor: string | null } =
            await channel.command('external.identity.repositories', {
              deviceId,
              limit: 100,
              ...(cursor ? { cursor } : {}),
            })
          if (!live) return
          all.push(...result.repositories)
          cursor = result.nextCursor
          if (!cursor) break
        }
        if (live) {
          setRepositories(all)
          setError('')
        }
      } catch (cause) {
        if (live) setError(reasonOf(cause, t))
      }
    }
    void load()
    return () => {
      live = false
    }
  }, [channel, deviceId, revision, canRead, t])
  return canRead
    ? { identities, repositories, error }
    : { identities: null, repositories: [], error: '' }
}
