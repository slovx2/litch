// 模拟帖子保留真实字段和交互语义，时间已是客户端毫秒。

import type { ManagerPost } from '../../../protocol/src/manager-posts.mjs'
import { managerSuggestionIssueStatus } from '../../../protocol/src/suggestion-inbox.mjs'
import type { ManagerBoardView } from '../model-manager.mjs'
import type { SuggestionView } from '../model-suggestions.mjs'
export function mockPosts(
  board: ManagerBoardView,
  suggestions: readonly SuggestionView[] = [],
): ManagerPost[] {
  const previous = board.posts ?? []
  board.relations ??= [
    {
      id: 'report-source',
      from: { kind: 'issue', target: 'P-1' },
      to: { kind: 'issue', target: 'D-15' },
      kind: 'derived',
      at: 0,
      by: 'manager',
    },
    {
      id: 'report-item',
      from: { kind: 'issue', target: 'P-1' },
      to: { kind: 'item', target: 'I-2' },
      kind: 'related',
      at: 0,
      by: 'manager',
    },
    {
      id: 'report-line',
      from: { kind: 'issue', target: 'P-1' },
      to: { kind: 'thread', target: 'manager-k1' },
      kind: 'related',
      at: 0,
      by: 'manager',
    },
    ...board.decisions.flatMap((d) =>
      d.blocks.map((id) => ({
        id: `${d.id}-${id}`,
        from: { kind: 'issue' as const, target: d.id },
        to: { kind: 'item' as const, target: id },
        kind: 'related' as const,
        at: 0,
        by: 'projection' as const,
      })),
    ),
  ]
  const empty = () => ({ messages: [], light: false, summary: null, forwarded: 0 })
  return [
    ...previous.filter((p) => p.kind === 'report'),
    ...board.decisions.map(
      (d): ManagerPost => ({
        id: d.id,
        kind: 'decision',
        title: d.title,
        body: d.background,
        revision: d.revision,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        fields: { title: d.title, body: d.background, options: d.options, recommend: d.recommend },
        discussion: d.discussion ?? previous.find((p) => p.id === d.id)?.discussion ?? empty(),
        versions: board.changes
          .filter((c) => c.objectId === d.id && c.before && c.fields.includes('background'))
          .map((c) => ({
            title: String(c.before?.title ?? ''),
            body: String(c.before?.background ?? ''),
            revision: Number(c.before?.revision ?? 1),
            at: c.at,
            by: c.by,
            why: c.why,
          })),
      }),
    ),
    ...(board.requests ?? []).map(
      (r): ManagerPost => ({
        id: r.id,
        kind: 'request',
        title: r.title,
        body: r.description,
        revision: r.revision,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        fields: { title: r.title, body: r.description, buttonLabel: r.buttonLabel },
        discussion: previous.find((p) => p.id === r.id)?.discussion ?? empty(),
        versions: [],
      }),
    ),
    ...suggestions.map(
      ({ proposal, source, managerReview }): ManagerPost => ({
        id: `S-${proposal.id}`,
        kind: 'suggestion',
        title: proposal.title,
        body: proposal.prompt,
        revision: 1,
        createdAt: proposal.createdAt,
        updatedAt: proposal.settledAt ?? proposal.createdAt,
        fields: {
          title: proposal.title,
          body: proposal.prompt,
          status: managerSuggestionIssueStatus(
            proposal.status,
            managerReview?.state ?? null,
            proposal.sourceIsManager === true,
          ),
          canStart: proposal.status === 'pending' && managerReview?.state !== 'dismissed',
          reviewed: managerReview !== undefined && managerReview.state !== 'pending',
        },
        proposalId: proposal.id,
        sourceThreadId: source.threadId,
        discussion: previous.find((p) => p.proposalId === proposal.id)?.discussion ?? empty(),
        versions: [],
      }),
    ),
    ...previous.filter(
      (p) => p.kind === 'suggestion' && !suggestions.some((s) => s.proposal.id === p.proposalId),
    ),
  ]
}
export function sampleReport(at: number, lang: string): ManagerPost {
  return {
    id: 'P-1',
    kind: 'report',
    title: lang === 'zh-CN' ? '第一版的范围与限制' : 'First version scope and limitations',
    body:
      lang === 'zh-CN'
        ? '## 已完成\n\n- 桌面 **经理看板**\n- 设备端版本校验\n\n## 尚未覆盖\n\n真机验证需用户交付。参见 #D-15 与 #I-2。'
        : '## Shipped\n\n- Desktop **manager board**\n- Revision validation\n\n## Remaining\n\nDevice verification requires user delivery.',
    revision: 1,
    createdAt: at,
    updatedAt: at,
    unread: true,
    fields: {},
    discussion: { messages: [], light: false, summary: null, forwarded: 0 },
    versions: [],
  }
}
