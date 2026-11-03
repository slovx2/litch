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
  const view = {
    deviceId: 'local',
    managerId: manager.id,
    available: true,
    board,
    paging: {
      summary: {
        manager,
        situation: null,
        counts: { request: { open: 3 }, decision: {}, item: {}, suggestion: {}, report: {} },
        initial: page,
        activities: [],
        lines: { lines: [], checkedAt: null, failed: 0 },
      },
      pages: { 'request/open/newest': page },
      histories: {},
      loading: [],
      error: null,
    },
    features: { feedback: true, posts: true, ignore: true, paging: true },
  }
  const calls: unknown[] = []
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
  return { core: host as CoreHost, manager, board, view, state: { calls } }
}
