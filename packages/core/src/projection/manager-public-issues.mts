import type { ManagerIssue, ManagerIssuePage } from '../../../protocol/src/manager-issues.mjs'
export function projectManagerIssue(issue: ManagerIssue): ManagerIssue {
  const question = (q: ManagerIssue['discussion']['questions'][number]) => ({
    ...q,
    at: q.at * 1000,
    ...(q.answeredAt === undefined ? {} : { answeredAt: q.answeredAt * 1000 }),
  })
  return {
    ...issue,
    createdAt: issue.createdAt * 1000,
    updatedAt: issue.updatedAt * 1000,
    followUp: { ...issue.followUp, changedAt: issue.followUp.changedAt * 1000 },
    discussion: {
      ...issue.discussion,
      comments: issue.discussion.comments.map((c) => ({
        ...c,
        createdAt: c.createdAt * 1000,
        updatedAt: c.updatedAt * 1000,
      })),
      questions: issue.discussion.questions.map(question),
      ...(issue.discussion.legacy
        ? {
            legacy: {
              ...issue.discussion.legacy,
              messages: issue.discussion.legacy.messages.map(question),
            },
          }
        : {}),
    },
    timeline: issue.timeline.map((entry) => ({ ...entry, at: entry.at * 1000 })),
    relations: issue.relations.map((r) => ({ ...r, at: r.at * 1000 })),
  }
}
export function projectManagerIssuePage(page: ManagerIssuePage): ManagerIssuePage {
  return {
    ...page,
    entries: page.entries.map((i) => ({
      ...i,
      createdAt: i.createdAt * 1000,
      updatedAt: i.updatedAt * 1000,
    })),
  }
}
export function managerIssuePending(issue: Pick<ManagerIssue, 'kind' | 'status'>): boolean {
  return (
    issue.kind !== 'report' &&
    ['open', 'pending', 'endorsed', 'in_progress', 'blocked'].includes(issue.status)
  )
}
