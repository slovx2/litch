import type { ExternalWriteReceipt } from '../../../../protocol/src/external-sources.mjs'
import type { ExternalWritePayload } from '../outbox-payload.mjs'
import { validGithubBranch } from '../outbox-payload.mjs'
import { GithubWriteFault, type GithubWriteResponse, numericId, object } from './write-api.mjs'

export const progressContext = 'litch/progress'
const description = {
  pending: 'Litch is working',
  success: 'Litch delivered',
  error: 'Litch needs attention',
}
type StatusPayload = Extract<ExternalWritePayload, { action: 'status' }>
type Api = { path: string; web: string; get: (endpoint: string) => Promise<GithubWriteResponse> }
type Target = { number: string; repoId: string; operationId: string }

function statusTarget(gh: Api, input: Target): string {
  return `${gh.web}/pull/${input.number}#litch-operation-${input.operationId}`
}

export async function prepareGithubStatus(gh: Api, target: Target, payload: StatusPayload) {
  const pr = object((await gh.get(`${gh.path}/pulls/${target.number}`)).body)
  const head = object(pr.head)
  const base = object(pr.base)
  if (
    numericId(pr.number) !== target.number ||
    numericId(object(pr.user).id) !== payload.botUserId ||
    numericId(object(base.repo).id) !== target.repoId ||
    numericId(object(head.repo).id) !== target.repoId ||
    head.sha !== payload.headSha ||
    !validGithubBranch(base.ref) ||
    pr.state !== 'open'
  )
    throw new GithubWriteFault('external_progress_pr_head_unverified')
  const branch = encodeURIComponent(base.ref)
  const rules = await optionalRead(gh, `${gh.path}/rules/branches/${branch}`)
  if (
    Array.isArray(rules) &&
    rules.some((rule) => {
      const checks = object(object(rule).parameters).required_status_checks
      return (
        Array.isArray(checks) && checks.some((check) => object(check).context === progressContext)
      )
    })
  )
    throw new GithubWriteFault('external_progress_used_as_gate')
  const legacy = object(
    await optionalRead(gh, `${gh.path}/branches/${branch}/protection/required_status_checks`),
  )
  if (
    (Array.isArray(legacy.contexts) && legacy.contexts.includes(progressContext)) ||
    (Array.isArray(legacy.checks) &&
      legacy.checks.some((check) => object(check).context === progressContext))
  )
    throw new GithubWriteFault('external_progress_used_as_gate')
  return {
    endpoint: `${gh.path}/statuses/${payload.headSha}`,
    body: {
      state: payload.state,
      context: progressContext,
      description: description[payload.state],
      target_url: statusTarget(gh, target),
    },
  }
}

async function optionalRead(gh: Api, path: string): Promise<unknown> {
  try {
    return (await gh.get(path)).body
  } catch (error) {
    // 启用已要求管理员确认。未授权读取保护规则不作冲突证据，其他暂时错误阻止写入。
    if (
      error instanceof GithubWriteFault &&
      ['github_permission_denied', 'github_target_unavailable'].includes(error.code)
    )
      return null
    throw error
  }
}

export function matchesGithubStatus(
  gh: Api,
  target: Target,
  payload: StatusPayload,
  value: unknown,
): boolean {
  const status = object(value)
  return (
    numericId(object(status.creator).id) === payload.botUserId &&
    status.context === progressContext &&
    status.state === payload.state &&
    status.description === description[payload.state] &&
    status.target_url === statusTarget(gh, target)
  )
}

export function githubStatusReceipt(
  gh: Api,
  target: Target,
  receipt: (url: string) => ExternalWriteReceipt,
) {
  return { receipt: receipt(statusTarget(gh, target)) }
}
