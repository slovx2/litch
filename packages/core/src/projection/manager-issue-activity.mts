import type { ManagerIssueTimelineEntry } from '../../../protocol/src/manager-issues.mjs'

const CONTENT_FIELDS = new Set(['title', 'body', 'background', 'options', 'recommend', 'status'])

/** 只筛选展示，不删除原始活动。关联/依据和讨论开关不属于经理的实质更新。 */
export function managerIssueActivity(
  timeline: readonly ManagerIssueTimelineEntry[],
  changes: readonly { id: string; fields: readonly string[] }[] = [],
): ManagerIssueTimelineEntry[] {
  const fields = new Map(changes.map((change) => [change.id, change.fields]))
  return timeline
    .filter((entry) => {
      if (entry.actor !== 'manager' || !Number.isFinite(entry.at) || entry.at <= 0) return false
      if (entry.kind !== 'edited' && entry.kind !== 'status') return false
      const changed = entry.changeId ? fields.get(entry.changeId) : undefined
      if (entry.kind === 'edited' && changed && !changed.some((field) => CONTENT_FIELDS.has(field)))
        return false
      // 关系投影没有变更字段；不把“编号→文件/分支/会话”当成正文修订。
      if (/^[A-Z]-[\w-]+\s*(?:→|->)/.test(entry.summary.trim())) return false
      if (
        /^(展开讨论|收起讨论|开启讨论|Open(?:ed)? discussion|Close(?:d)? discussion)$/i.test(
          entry.summary.trim(),
        )
      )
        return false
      return true
    })
    .map((entry) => ({
      ...entry,
      // 活动行不是文件入口；含本机绝对路径的操作原因只展示通用更新类型。
      summary: /(?:\/(?:Users|home|root|Volumes|tmp)\/|~\/|[A-Za-z]:[\\/])/.test(entry.summary)
        ? ''
        : entry.summary,
    }))
}
