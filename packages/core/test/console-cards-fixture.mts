// 两端真实分页组件共用的隔离看板；文件存在、缺失和离线均由模拟通道返回。

import type { CoreHost } from '../src/channel/server.mjs'
import { mockPosts } from '../src/mock/manager-posts.mjs'
import { sampleManagers } from '../src/mock/sample-manager.mjs'
export function consoleCardsFixture(mock: CoreHost) {
  const { managers, boards } = sampleManagers('local', Date.now(), 'zh-CN')
  const original = managers[0]
  const board = boards[0]
  if (!original || !board?.requests?.[0]) throw new Error('缺少模拟经理请求')
  const manager = { ...original, cwd: '/project' }
  const links = [
    { kind: 'file', target: '/outside/STORE.md', label: '上架准备' },
    { kind: 'file', target: '/outside/folder', label: '目录' },
    { kind: 'file', target: '/missing', label: '缺失文件' },
    { kind: 'file', target: '/offline', label: '离线文件' },
    { kind: 'url', target: 'https://example.com', label: '网页' },
    { kind: 'branch', target: 'main', label: '分支' },
    { kind: 'commit', target: 'abc123', label: '提交' },
    { kind: 'thread', target: 'manager-k1', label: '工作线' },
    { kind: 'issue', target: 'D-15', label: '决策' },
    { kind: 'item', target: 'I-2', label: '事项' },
  ] as const
  board.requests = [1, 2, 3].map((n) => ({
    ...board.requests![0],
    id: `R-${n}`,
    title: `请求 ${n}`,
    description: '完整说明\n\n'.repeat(15),
    status: 'open',
    links: links.filter((l) => !['issue', 'item'].includes(l.kind)),
    basis: [],
  })) as NonNullable<typeof board.requests>
  // 决策页：八条，正文够长能滚动；D-7 草稿写在旧版本、后来在别处答复（失效），D-8 已关闭
  const template = board.decisions.find((d) => d.options.length >= 3) ?? board.decisions[0]
  if (!template) throw new Error('缺少模拟经理决策')
  const titles = [
    '发版前要不要在 Windows 真机补验',
    '插话消息在不支持的 harness 上露不露编辑',
    '子会话要不要算进后台任务',
    'Pi 压缩失败要不要在网关兜底',
    '定时任务回合里的审批没人答等多久',
    '手机端要不要画 mermaid',
    '旧版设备服务的草稿留多久',
    '侧栏草稿数要不要算进待处理',
  ]
  board.decisions = titles.map((title, index) => {
    const n = index + 1
    const answered = n === 7
    const closed = n === 8
    return {
      ...template,
      id: `D-${n}` as const,
      title,
      background: `第 ${n} 条决策的背景。\n\n${'说明一段比较长的背景，让展开后的卡片超过一屏。\n\n'.repeat(6)}`,
      options: [
        { id: 'a', label: '照推荐做', description: '' },
        { id: 'b', label: '先发，补验放下一版', description: '' },
        { id: 'c', label: '不做', description: '' },
      ],
      recommend: 'a',
      blocks: [],
      links: [],
      revision: answered ? 2 : 1,
      status: answered ? ('answered' as const) : closed ? ('expired' as const) : ('open' as const),
      answer: answered
        ? { optionId: 'c', text: '', by: 'user-conversation', at: Date.now() }
        : null,
      closed: closed ? { reason: '不用再定', by: 'manager', at: Date.now() } : null,
      createdAt: Date.now() - n * 60_000,
      updatedAt: Date.now() - n * 60_000,
    }
  })
  board.posts = mockPosts(board)
  board.relations = links.map((to, n) => ({
    id: `rel-${n}`,
    kind: 'related',
    from: { kind: 'issue', target: 'R-2' },
    to,
    at: 0,
    by: 'manager',
  }))
  const query = { kind: 'request', status: 'open', order: 'newest' } as const
  const page = {
    query,
    entries: board.requests!.map((r) => ({
      ...r,
      kind: 'request',
      preview: '摘要',
      pending: true,
    })),
    total: 3,
    nextCursor: null,
  }
  const decisionPage = (status: string, decisions = board.decisions) => {
    const entries = decisions
      .filter(
        (d) =>
          status === 'all' ||
          d.status === status ||
          (status === 'closed' && ['expired', 'withdrawn'].includes(d.status)),
      )
      .map((d) => ({
        id: d.id,
        kind: 'decision',
        title: d.title,
        preview: `第 ${d.id.slice(2)} 条决策的背景摘要，收起时最多两行。`,
        status: d.status,
        pending: d.status === 'open',
        revision: d.revision,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      }))
    return {
      query: { kind: 'decision', status, order: 'newest' },
      entries,
      total: entries.length,
      nextCursor: null,
    }
  }
  const pagesOf = (decisions = board.decisions) =>
    Object.fromEntries(
      ['open', 'answered', 'closed', 'ignored', 'all'].map((status) => [
        `decision/${status}/newest`,
        decisionPage(status, decisions),
      ]),
    )
  const decisionPages = pagesOf()
  const view = {
    deviceId: 'local',
    managerId: manager.id,
    available: true,
    board,
    paging: {
      summary: {
        manager,
        situation: null,
        counts: {
          request: { open: 3 },
          decision: { open: 6, answered: 1, closed: 1, ignored: 0, all: 8 },
          item: {},
          suggestion: {},
          report: {},
        },
        initial: page,
        activities: [],
        lines: { lines: [], checkedAt: null, failed: 0 },
      },
      pages: { 'request/open/newest': page, ...decisionPages },
      histories: {},
      loading: [],
      error: null,
    },
    features: { feedback: true, posts: true, ignore: true, paging: true },
  }
  const calls: unknown[] = []
  /** 提交后看板更新（?settle=1 时界面夹具接上）：交掉的决策改成已答复，离开待定分页 */
  const state: { calls: unknown[]; onSubmit: ((ids: string[]) => void) | null } = {
    calls,
    onSubmit: null,
  }
  const settle = (ids: readonly string[]) => {
    const decisions = board.decisions.map((d) =>
      ids.includes(d.id) ? { ...d, status: 'answered' as const, revision: d.revision + 1 } : d,
    )
    return {
      ...view,
      board: { ...board, decisions },
      paging: { ...view.paging, pages: { ...view.paging.pages, ...pagesOf(decisions) } },
    }
  }
  const host = {
    ...mock,
    subscribe(
      topic: Parameters<CoreHost['subscribe']>[0],
      sink: Parameters<CoreHost['subscribe']>[1],
    ) {
      if (topic.kind === 'managerBoard' && topic.managerId === manager.id) {
        sink.snapshot(view)
        return () => {}
      }
      return mock.subscribe(topic, sink)
    },
    async command(name: string, params: any, signal: any) {
      calls.push({ name, params })
      if (name.startsWith('managers.board.')) return {}
      // 批量提交照单全收；看板不变，只看草稿清掉和提交条的反馈
      if (name === 'managers.feedback.submit') {
        const find = (id: string) => board.decisions.find((d) => d.id === id)
        state.onSubmit?.(params.answers.map((a: { decisionId: string }) => a.decisionId))
        return {
          accepted: params.answers.map((a: { decisionId: string }) => find(a.decisionId)),
          rejected: [],
          acceptedQuestions: params.questions.map((q: { decisionId: string }) =>
            find(q.decisionId),
          ),
          rejectedQuestions: [],
          acceptedRequests: params.requests.map((r: { requestId: string }) =>
            board.requests?.find((one) => one.id === r.requestId),
          ),
          rejectedRequests: [],
          delivery: 'none',
        }
      }
      if (name === 'files.read' && params.path.startsWith('/outside'))
        return params.path.endsWith('folder')
          ? { kind: 'directory', path: params.path }
          : {
              kind: 'text',
              path: params.path,
              text: '隔离文件预览',
              bytes: 18,
              language: 'markdown',
              lossy: false,
            }
      if (name === 'files.list' && params.path.startsWith('/outside'))
        return { path: params.path, entries: [{ name: 'STORE.md', kind: 'file' }], total: 1 }

      if (name === 'files.resolve') {
        const path = params.ref.path
        const failure = path === '/missing' ? 'missing' : path === '/offline' ? 'offline' : null
        return {
          status: failure ? 'failed' : 'ready',
          href: path,
          path,
          attempted: [path],
          candidates: failure
            ? []
            : [{ root: '/outside', path, kind: path.endsWith('folder') ? 'directory' : 'file' }],
          failures: failure ? [{ path, reason: failure }] : [],
        }
      }
      return mock.command(name, params, signal)
    },
  }
  // 预置草稿（预览和验收按需写入）：D-2 选项加追问、D-3 文字、D-5 只有追问、D-7 写在旧版本（已在别处答复，失效）
  const key = (id: string) => JSON.stringify([manager.deviceId, manager.id, id])
  const drafts = {
    answers: {
      'D-2': {
        decisionId: 'D-2',
        revision: 1,
        optionId: 'b',
        text: '',
        question: '为什么不先做 A？',
      },
      'D-3': { decisionId: 'D-3', revision: 1, optionId: null, text: '两个都算，但侧栏分开显示' },
      'D-5': {
        decisionId: 'D-5',
        revision: 1,
        optionId: null,
        text: '',
        question: '超时后怎么记录？',
      },
      'D-7': { decisionId: 'D-7', revision: 1, optionId: 'a', text: '' },
    },
    /** 加上这条就有一张“草稿待确认”：D-4 一直待定，草稿写在更早的版本上 */
    conflict: {
      'D-4': { decisionId: 'D-4', revision: 0, optionId: null, text: '先看清楚再答' },
    },
    mobile: {
      'manager-choices.json': { [key('D-2')]: 'b', [key('D-7')]: 'a' },
      'manager-replies.json': { [key('D-3')]: '两个都算，但侧栏分开显示' },
      'manager-questions.json': {
        [key('D-2')]: '为什么不先做 A？',
        [key('D-5')]: '超时后怎么记录？',
      },
      'manager-draft-revisions.json': {
        [key('D-2')]: 1,
        [key('D-3')]: 1,
        [key('D-5')]: 1,
        [key('D-7')]: 1,
      },
    },
  }
  return { core: host as CoreHost, manager, board, view, drafts, settle, state }
}
