// 快照保留设备原始时间（UTC 秒）；fetchedAt 是客户端时间（毫秒）。
import type {
  DeviceAutostartRequests,
  DeviceAutostartStatus,
} from '../../../protocol/src/device-autostart.mjs'
import { DEVICE_AUTOSTART_METHOD } from '../../../protocol/src/device-autostart.mjs'
import type {
  ExternalAccess,
  ExternalConfiguration,
  ExternalIdentityLogin,
  ExternalInboxEvent,
  ExternalInboxQuery,
  ExternalOutboxQuery,
  ExternalOutboxSummary,
  ExternalOwner,
  ExternalOwnerIdentity,
  ExternalPage,
  ExternalRequests,
  ExternalSourceStatus,
} from '../../../protocol/src/external-sources.mjs'
import { EXTERNAL_METHOD } from '../../../protocol/src/external-sources.mjs'
import type { ChannelErrorShape } from '../channel/protocol.mjs'

export type ExternalInboxFilter = Omit<ExternalInboxQuery, 'limit' | 'beforeSeq'>
export type ExternalOutboxFilter = Omit<ExternalOutboxQuery, 'limit' | 'beforeSeq'>

export type ExternalDeviceTopic =
  | { kind: 'externalDevice'; deviceId: string }
  | { kind: 'externalIdentityLogin'; deviceId: string; loginId: string }
  | { kind: 'externalInbox'; deviceId: string; filter: ExternalInboxFilter }
  | { kind: 'externalOutbox'; deviceId: string; filter: ExternalOutboxFilter }

export interface ExternalSnapshot<T> {
  available: boolean
  online: boolean
  value: T | null
  fetchedAt: number | null
  error: ChannelErrorShape | null
}

export interface ExternalDeviceView {
  owner: ExternalSnapshot<ExternalOwner>
  sources: ExternalSnapshot<ExternalSourceStatus[]>
  autostart: ExternalSnapshot<DeviceAutostartStatus>
  configuration?: ExternalSnapshot<ExternalConfiguration>
  access?: ExternalAccess
}
export type ExternalIdentityLoginView = ExternalSnapshot<ExternalIdentityLogin>
export type ExternalInboxView = ExternalSnapshot<ExternalPage<ExternalInboxEvent>> & {
  access?: ExternalAccess
}
export type ExternalOutboxView = ExternalSnapshot<ExternalPage<ExternalOutboxSummary>>

export type ExternalOwnerInput =
  | { method: 'profileUrl' | 'userId'; value: string }
  | { method: 'localGh' }
export interface GlobalExternalOwner {
  owner: ExternalOwnerIdentity
  revision: number
}
export type ExternalOwnerSyncState = 'synced' | 'different' | 'offline' | 'unsupported' | 'failed'
export interface ExternalOwnerSyncRow {
  deviceId: string
  state: ExternalOwnerSyncState
  owner: ExternalOwner | null
  expectedRevision: number | null
}

export const EXTERNAL_COMMAND = {
  'external.owner.get': EXTERNAL_METHOD.ownerGet,
  'external.owner.set': EXTERNAL_METHOD.ownerSet,
  'external.source.list': EXTERNAL_METHOD.sourceList,
  'external.source.get': EXTERNAL_METHOD.sourceGet,
  'external.source.upsert': EXTERNAL_METHOD.sourceUpsert,
  'external.source.preview': EXTERNAL_METHOD.sourcePreview,
  'external.source.check': EXTERNAL_METHOD.sourceCheck,
  'external.source.pause': EXTERNAL_METHOD.sourcePause,
  'external.source.resume': EXTERNAL_METHOD.sourceResume,
  'external.identity.list': EXTERNAL_METHOD.identityList,
  'external.identity.add': EXTERNAL_METHOD.identityAdd,
  'external.identity.import': EXTERNAL_METHOD.identityImport,
  'external.identity.paste': EXTERNAL_METHOD.identityPaste,
  'external.identity.login.get': EXTERNAL_METHOD.identityLoginGet,
  'external.identity.login.cancel': EXTERNAL_METHOD.identityLoginCancel,
  'external.identity.login.confirm': EXTERNAL_METHOD.identityLoginConfirm,
  'external.identity.rotate': EXTERNAL_METHOD.identityRotate,
  'external.identity.revoke': EXTERNAL_METHOD.identityRevoke,
  'external.identity.repositories': EXTERNAL_METHOD.identityRepositories,
  'external.configuration.get': EXTERNAL_METHOD.configurationGet,
  'external.manager.assignment.get': EXTERNAL_METHOD.managerAssignmentGet,
  'external.manager.assignment.set': EXTERNAL_METHOD.managerAssignmentSet,
  'external.inbox.get': EXTERNAL_METHOD.inboxGet,
  'external.inbox.triage': EXTERNAL_METHOD.inboxTriage,
  'external.autostart.status': DEVICE_AUTOSTART_METHOD.get,
  'external.autostart.enable': DEVICE_AUTOSTART_METHOD.enable,
  'external.autostart.disable': DEVICE_AUTOSTART_METHOD.disable,
} as const

export type ExternalWireRequests = ExternalRequests & DeviceAutostartRequests
export type ExternalCommandName = keyof typeof EXTERNAL_COMMAND
type WireParams<M extends ExternalCommandName> =
  ExternalWireRequests[(typeof EXTERNAL_COMMAND)[M]]['params']
export type ExternalCommandArgs<M extends ExternalCommandName> = (WireParams<M> extends Record<
  string,
  never
>
  ? unknown
  : WireParams<M>) & { deviceId: string }
export type ExternalCommands = {
  [M in ExternalCommandName]: {
    params: ExternalCommandArgs<M>
    result: ExternalWireRequests[(typeof EXTERNAL_COMMAND)[M]]['result']
  }
} & {
  'external.inbox.more': {
    params: { deviceId: string; filter: ExternalInboxFilter }
    result: undefined
  }
  'external.outbox.more': {
    params: { deviceId: string; filter: ExternalOutboxFilter }
    result: undefined
  }
  'external.identity.avatar': { params: { userId: string }; result: string | null }
  'external.owner.resolve': { params: ExternalOwnerInput; result: ExternalOwnerIdentity }
  'external.owner.global.get': { params: Record<string, never>; result: GlobalExternalOwner | null }
  'external.owner.global.plan': {
    params: { owner: ExternalOwnerIdentity }
    result: ExternalOwnerSyncRow[]
  }
  'external.owner.global.set': {
    params: {
      owner: ExternalOwnerIdentity
      expectedRevision: number
      devices: { deviceId: string; expectedRevision: number }[]
      operationId: string
    }
    result: { global: GlobalExternalOwner; devices: ExternalOwnerSyncRow[] }
  }
}

export function isExternalCommand(name: string): name is ExternalCommandName {
  return Object.hasOwn(EXTERNAL_COMMAND, name)
}

// 同一组页的过滤条件可由不同界面构造；属性顺序与状态枚举顺序不影响共享缓存。
export function externalFilterKey(filter: ExternalInboxFilter | ExternalOutboxFilter): string {
  return JSON.stringify(
    Object.entries(filter)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value]),
  )
}

export function externalSourceDraft({
  revision: _revision,
  rulesVersion: _rulesVersion,
  createdAt: _createdAt,
  ...draft
}: ExternalSourceStatus['source']) {
  return draft
}

/** 设备链接加上严格的主机边界；协议里收到的普通外部文本不能成为链接。 */
export function githubExternalUrl(value: string): string | undefined {
  return /^https:\/\/github\.com\/[^\s\\]+$/u.test(value) ? value : undefined
}
