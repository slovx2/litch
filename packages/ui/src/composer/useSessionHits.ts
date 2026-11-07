// 打 `@` 弹出的单子里“会话”那一组：从状态库里取这台设备的会话，交给 session-hits.ts 挑和排。
// 只列这台设备上的（提到的会话要和当前会话在同一台设备上，模型才读得到），侧栏里藏着的（别的应用派出、
// 没在“更多”里打开的）不列，归档的不列。
import {
  type DeviceView,
  keys,
  type MessageExtra,
  mentionTitle,
  SESSION_MENTION_LIMITS,
  type SessionCatalog,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'
import { useT } from '../app/appearance.ts'
import { nameOf } from '../app/device.ts'
import { useKey } from '../app/services.tsx'
import { useSidebarNativeChildren } from '../sidebar/state.ts'
import type { SuggestEntry, SuggestGroup } from './Suggest.tsx'
import { catalogCandidates } from './session-catalog.ts'
import { sessionHits } from './session-hits.ts'

const NONE = 'none'
const NO_IDS: string[] = []

export interface SessionHits {
  group: SuggestGroup
  /** 单子里的一项对应的会话；不是会话的是 null */
  extraOf(entryId: string): Extract<MessageExtra, { kind: 'session' }> | null
}

const idOf = (sessionId: string) => `session:${sessionId}`

/**
 * query 是 `@` 后面打的字；null 是单子没开（这时什么都不订阅）。current 是当前会话（新建页上没有），
 * bound 是这条消息里已经提到的会话
 */
export function useSessionHits(
  host: { deviceId: string; current: string | null; bound: readonly string[] },
  query: string | null,
): SessionHits {
  const t = useT()
  const { deviceId } = host
  const open = query !== null
  const catalog = useKey<SessionCatalog>(open ? keys.sessionCatalog(deviceId) : NONE)
  const native = useKey<string[]>(open ? keys.nativeChildren(deviceId) : NONE) ?? NO_IDS
  const showNative = useSidebarNativeChildren()
  const workspaces = useKey<WorkspaceView[]>(open ? keys.workspaces(deviceId) : NONE)
  const device = useKey<DeviceView>(keys.device(deviceId))
  const here = useKey<SessionSummary>(
    open && host.current ? keys.summary(deviceId, host.current) : NONE,
  )

  const candidates = catalogCandidates(
    catalog ?? [],
    workspaces ?? [],
    (title) => mentionTitle(t.text(title)),
    (kind) => t(`session.kind.${kind}`),
    new Set(showNative ? [] : native),
  )
  const full = host.bound.length >= SESSION_MENTION_LIMITS.perMessage
  const shown = full
    ? []
    : sessionHits(candidates, {
        query: query ?? '',
        current: host.current,
        workspaceId: here?.workspaceId ?? null,
        bound: new Set(host.bound),
      })
  const entries: SuggestEntry[] = shown.map((one) => ({
    id: idOf(one.id),
    kind: 'session',
    title: one.title,
    note: [one.typeLabel, one.workspace, nameOf(device, one.harness, t)]
      .filter(Boolean)
      .join(' · '),
    // 行上写了工作区和 harness，底下那一栏只补目录
    ...(one.cwd ? { facts: [{ label: t('at.path'), value: one.cwd }] } : {}),
    words: [],
  }))
  const status: SuggestGroup['status'] = full
    ? { text: t('at.sessions.full', { max: SESSION_MENTION_LIMITS.perMessage }) }
    : undefined

  return {
    group: {
      id: 'sessions',
      title: t('at.group.sessions'),
      entries,
      ...(status ? { status } : {}),
    },
    extraOf(entryId) {
      const one = shown.find((entry) => idOf(entry.id) === entryId)
      return one ? { kind: 'session', threadId: one.id, title: one.title } : null
    },
  }
}
