// 能力自检（只读）与补申请：在线版本的权限、事件、回调与清单比；补申请只追加清单里有的项，再提交发布。
// 用应用自管理接口读在线版本、追加配置、提交发布。发布会给企业管理员发审核通知，所以只在用户点按钮时做。
import type { FeishuCapability } from '../../../protocol/src/feishu.mjs'
import { type FeishuApi, FeishuApiError } from './api.mjs'
import { type CapabilityDiff, diffCapability, PATCH_SCOPE } from './permissions.mjs'

interface Snapshot {
  status: number | undefined
  versions: {
    version_id?: string
    version?: string
    status?: number
    event_infos?: { event_type?: string }[]
  }[]
  onlineVersionId: string
  scopes: Set<string>
  callbacks: Set<string>
}

async function snapshot(api: FeishuApi): Promise<Snapshot> {
  const info = await api.data<{ app?: Record<string, unknown> }>(
    'GET',
    '/open-apis/application/v6/applications/me',
    {
      query: { lang: 'zh_cn' },
    },
  )
  const app = info.app ?? {}
  const versions: Snapshot['versions'] = []
  let pageToken = ''
  const seen = new Set<string>()
  for (let page = 0; page < 20; page++) {
    const data = await api.data<{
      items?: Snapshot['versions']
      has_more?: boolean
      page_token?: string
    }>('GET', '/open-apis/application/v6/applications/me/app_versions', {
      query: {
        lang: 'zh_cn',
        page_size: 50,
        order: 0,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    })
    versions.push(...(data.items ?? []))
    if (!data.has_more) break
    pageToken = String(data.page_token ?? '')
    if (!pageToken || seen.has(pageToken)) break
    seen.add(pageToken)
  }
  const grants = await api.data<{
    scopes?: { scope_name?: string; scope_type?: string; grant_status?: number }[]
  }>('GET', '/open-apis/application/v6/scopes')
  const callbackInfo = (app.callback_info ?? {}) as { subscribed_callbacks?: unknown }
  return {
    status: typeof app.status === 'number' ? app.status : undefined,
    versions,
    onlineVersionId: String(app.online_version_id ?? ''),
    scopes: new Set(
      (grants.scopes ?? [])
        .filter((item) => item.scope_type === 'tenant' && item.grant_status === 1)
        .map((item) => String(item.scope_name)),
    ),
    callbacks: new Set(
      Array.isArray(callbackInfo.subscribed_callbacks)
        ? callbackInfo.subscribed_callbacks.map(String)
        : [],
    ),
  }
}

function onlineEvents(shot: Snapshot): Set<string> {
  const online = shot.versions.find(
    (item) => item.version_id === shot.onlineVersionId && item.status === 1,
  )
  return new Set(
    (online?.event_infos ?? []).map((item) => String(item.event_type ?? '').trim()).filter(Boolean),
  )
}

export async function checkCapability(
  api: FeishuApi,
  now: number,
  previous: FeishuCapability | null,
): Promise<FeishuCapability> {
  const empty = { missingScopes: [], missingEvents: [], missingCallbacks: [] }
  let shot: Snapshot
  try {
    shot = await snapshot(api)
  } catch (error) {
    if (error instanceof FeishuApiError && error.kind === 'permission')
      return { checkedAt: now, state: 'needs_self_manage', ...empty }
    return { checkedAt: now, state: 'unknown', ...empty }
  }
  const diff = diffCapability({
    scopes: shot.scopes,
    events: onlineEvents(shot),
    callbacks: shot.callbacks,
  })
  const missing =
    diff.missingScopes.length + diff.missingEvents.length + diff.missingCallbacks.length > 0
  const result: FeishuCapability = {
    checkedAt: now,
    state: shot.status === 0 ? 'app_disabled' : missing ? 'missing' : 'ok',
    ...diff,
  }
  const publish = previous?.publish
  if (publish?.versionId) {
    const version = shot.versions.find((item) => item.version_id === publish.versionId)
    result.publish = {
      ...publish,
      state: version?.status === 1 ? 'published' : version ? 'pending_review' : 'unknown',
    }
  }
  return result
}

function nextVersion(versions: Snapshot['versions']): string {
  let best: [number, number, number] = [1, 0, 0]
  for (const item of versions) {
    const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(item.version ?? '')
    if (!parts) continue
    const value: [number, number, number] = [
      Number(parts[1]),
      Number(parts[2]),
      Number(parts[3]) + 1,
    ]
    const [a1, a2, a3] = value
    const [b1, b2, b3] = best
    if (a1 > b1 || (a1 === b1 && (a2 > b2 || (a2 === b2 && a3 > b3)))) best = value
  }
  return best.join('.')
}

export function upgradeBody(diff: CapabilityDiff): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (diff.missingScopes.length > 0)
    body.scope = {
      add_scopes: diff.missingScopes.map((scope_name) => ({ scope_name, token_type: 'tenant' })),
    }
  if (diff.missingEvents.length > 0)
    body.event = { subscription_type: 'websocket', add_events: diff.missingEvents }
  if (diff.missingCallbacks.length > 0) body.callback = { add_callbacks: diff.missingCallbacks }
  return body
}

/** 补申请并提交发布。没有补申请权限时原样返回自检结果 */
export async function upgradeCapability(
  api: FeishuApi,
  now: number,
  previous: FeishuCapability | null,
): Promise<FeishuCapability> {
  const current = await checkCapability(api, now, previous)
  if (current.state !== 'missing') return current
  const shot = await snapshot(api)
  if (!shot.scopes.has(PATCH_SCOPE)) return { ...current, state: 'needs_self_manage' }
  await api.call('PATCH', `/open-apis/application/v7/applications/${api.appId}/config`, {
    body: upgradeBody(current),
  })
  const published = await api.data<{ version_id?: string }>(
    'POST',
    `/open-apis/application/v7/applications/${api.appId}/publish`,
    {
      body: {
        version: nextVersion(shot.versions),
        remark: 'Litch 补齐所需的权限、事件和回调',
        changelog: '补齐 Litch 接入所需的权限、事件订阅和回调',
      },
    },
  )
  return {
    ...current,
    publish: {
      state: 'pending_review',
      ...(published.version_id ? { versionId: published.version_id } : {}),
      at: now,
    },
  }
}
