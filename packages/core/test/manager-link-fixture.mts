// 编号跳转验收：两端使用同一份隔离模拟看板，支持详情延迟与状态更新。
import type { CoreHost } from '../src/channel/server.mjs'
import { mockPosts, sampleReport } from '../src/mock/manager-posts.mjs'
import { consoleCardsFixture } from './console-cards-fixture.mjs'

export function managerLinkFixture(mock: CoreHost) {
  const fixture = consoleCardsFixture(mock)
  const view = fixture.view
  const board = view.board
  // 模拟经理对话已有 D-15 引用，用它直接覆盖“在聊天里点已答复编号”的路径。
  const answered = board.decisions[6]
  if (!answered) throw new Error('缺少已答复决策夹具')
  answered.id = 'D-15'
  const sinks = new Set<Parameters<CoreHost['subscribe']>[1]>()
  let delayed = false
  let loaded = new Set<string>()
  const calls: unknown[] = []
  board.posts = [...mockPosts(board), sampleReport(Date.now(), 'zh-CN')]
  const publish = () => {
    const shown = {
      ...view,
      board: delayed
        ? {
            ...board,
            decisions: board.decisions.filter((one) => loaded.has(one.id)),
            items: board.items.filter((one) => loaded.has(one.id)),
            requests: board.requests?.filter((one) => loaded.has(one.id)),
            posts: board.posts?.filter((one) => loaded.has(one.id)),
          }
        : board,
    }
    for (const sink of sinks) sink.snapshot(structuredClone(shown))
  }
  const state = {
    calls,
    change(id: string, status: string) {
      const object = [...board.decisions, ...board.items, ...(board.requests ?? [])].find(
        (one) => one.id === id,
      )
      if (object) Object.assign(object, { status, revision: object.revision + 1 })
      else {
        const post = board.posts?.find((one) => one.id === id)
        if (post) post.unread = status === 'unread'
      }
      board.posts = mockPosts(board)
      publish()
    },
    delay() {
      delayed = true
      loaded = new Set()
      publish()
    },
  }
  const host = {
    ...fixture.core,
    subscribe(topic: any, sink: any) {
      calls.push({ subscribe: topic })
      if (topic.kind !== 'managerBoard') return fixture.core.subscribe(topic, sink)
      sinks.add(sink)
      publish()
      return () => sinks.delete(sink)
    },
    async command(name: string, params: any, signal: any) {
      calls.push({ name, params })
      if (name === 'managers.board.detail') {
        if (delayed) await new Promise((resolve) => setTimeout(resolve, 180))
        loaded.add(params.id)
        publish()
        return {}
      }
      if (name === 'managers.board.page') {
        const objects =
          params.kind === 'decision'
            ? board.decisions
            : params.kind === 'item'
              ? board.items
              : params.kind === 'request'
                ? (board.requests ?? [])
                : (board.posts ?? []).filter((one) => one.kind === params.kind)
        const entries = objects
          .map((one: any) => ({
            ...one,
            kind: params.kind,
            status: 'status' in one ? one.status : one.unread ? 'unread' : 'read',
            preview: one.title,
          }))
          .filter(
            (one) =>
              params.status === 'all' ||
              params.status === one.status ||
              (params.status === 'closed' && ['expired', 'withdrawn'].includes(one.status)),
          )
        Object.assign(view.paging.pages, {
          [`${params.kind}/${params.status}/${params.order}`]: {
            query: params,
            entries,
            total: entries.length,
            nextCursor: null,
          },
        })
        publish()
        return {}
      }
      return fixture.core.command(name, params, signal)
    },
  }

  return { core: host as CoreHost, state }
}
