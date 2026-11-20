import type { ExternalSourceDraft } from '@litch/core'

export const csv = (value: string) => [
  ...new Set(
    value
      .split(',')
      .map((one) => one.trim())
      .filter(Boolean),
  ),
]
const numericId = (value: string) => /^[1-9]\d*$/u.test(value)

export function draftReady(draft: ExternalSourceDraft): boolean {
  const repo = draft.repos[0]
  const labels = repo?.labelRoutes ?? []
  return Boolean(
    draft.sourceId.trim() &&
      draft.credentialRef &&
      numericId(draft.botUserId) &&
      Number.isSafeInteger(draft.interval) &&
      draft.interval > 0 &&
      draft.repos.length === 1 &&
      repo?.localRoot.trim() &&
      repo.allowedBase.length &&
      repo.headNamespace.trim() &&
      labels.every((route) => numericId(route.labelId) && route.managerId) &&
      new Set(labels.map((route) => route.labelId)).size === labels.length,
  )
}
