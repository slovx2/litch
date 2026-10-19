// 界面这一侧的文件树：一棵树是一台设备上的一个根。这里记着“哪些目录展开着、各层取到了什么”，
// 把它们摊平成行放进状态库，界面只订阅行、只画看得见的那几十行。
// 懒加载：根一层、每展开一个目录一层，各发一条 files.list；收起不丢已经取到的，再展开时先照旧显示、同时重新取
// （核心那边有几秒的缓存，刚取过的不会真的再问对面）。
// 状态只在这次运行里：换会话、收起面板再回来，展开的样子还在。
import type { CoreChannel } from '../channel/client.mjs'
import { type ChannelErrorShape, toChannelError } from '../channel/protocol.mjs'
import type { DirectoryView, FileTreeState } from '../model-files.mjs'
import { flattenTree, type TreeListing } from '../projection/files.mjs'
import { insideRoot, normalizePath, parentPath } from '../text/paths.mjs'
import type { KeyedStore } from './keyed-store.mjs'

export const fileKeys = {
  /** FileRow[]：这棵树摊平之后的行 */
  rows: (deviceId: string, root: string) => `files:${deviceId}:rows:${root}`,
  /** FileTreeState：根目录取到没有、是不是正在刷新 */
  tree: (deviceId: string, root: string) => `files:${deviceId}:tree:${root}`,
  /** boolean：显不显示隐藏的文件 */
  showHidden: 'files:showHidden',
}

export interface FileTrees {
  /**
   * 开始看一棵树：没取过根就去取，取过的重新对一遍（展开着的各层）。
   * 返回“不看了”的函数；不看了状态也留着，这次运行里再回来还是原样
   */
  open(deviceId: string, root: string): () => void
  expand(deviceId: string, root: string, path: string): void
  collapse(deviceId: string, root: string, path: string): void
  /** 把一个路径上面的各级目录都展开，让它在树里看得见。各级都取到了是 true */
  reveal(deviceId: string, root: string, path: string): Promise<boolean>
  /** 不用缓存，把根和展开着的各层重新取一遍 */
  refresh(deviceId: string, root: string): Promise<void>
  /** 显不显示隐藏的文件。所有的树一起变，不用重新取 */
  setShowHidden(show: boolean): void
  /** 一台设备重新连上了：正看着的树重新对一遍 */
  reconnected(deviceId: string): void
  /** 这台设备不要了 */
  drop(deviceId: string): void
}

interface Tree {
  deviceId: string
  root: string
  listings: Map<string, TreeListing>
  expanded: Set<string>
  /** 各层最近一次请求的代号：迟到的应答按它作废 */
  latest: Map<string, number>
  watchers: number
  refreshing: number
}

const sameView = (a: DirectoryView | null, b: DirectoryView): boolean => {
  if (!a || a.total !== b.total || a.entries.length !== b.entries.length) return false
  for (let at = 0; at < a.entries.length; at++) {
    const x = a.entries[at]
    const y = b.entries[at]
    if (x?.name !== y?.name || x?.kind !== y?.kind) return false
  }
  return true
}

export function createFileTrees(channel: CoreChannel, store: KeyedStore): FileTrees {
  const trees = new Map<string, Tree>()
  let showHidden = false
  let seq = 0
  store.set(fileKeys.showHidden, showHidden)

  const treeOf = (deviceId: string, rawRoot: string): Tree => {
    const root = normalizePath(rawRoot)
    const key = `${deviceId}\n${root}`
    let tree = trees.get(key)
    if (!tree) {
      tree = {
        deviceId,
        root,
        listings: new Map(),
        expanded: new Set(),
        latest: new Map(),
        watchers: 0,
        refreshing: 0,
      }
      trees.set(key, tree)
    }
    return tree
  }

  const stateOf = (tree: Tree): FileTreeState => {
    const top = tree.listings.get(tree.root)
    const phase = top?.view ? 'ready' : top?.state === 'failed' ? 'failed' : 'loading'
    return {
      phase,
      error: phase === 'failed' ? (top?.error ?? null) : null,
      refreshing: tree.refreshing > 0,
    }
  }

  /** 只发状态（取到没有、是不是正在刷新）。没变就不发 */
  const publishState = (tree: Tree) => {
    const next = stateOf(tree)
    const before = store.get<FileTreeState>(fileKeys.tree(tree.deviceId, tree.root))
    if (
      !before ||
      before.phase !== next.phase ||
      before.refreshing !== next.refreshing ||
      before.error !== next.error
    ) {
      store.set(fileKeys.tree(tree.deviceId, tree.root), next)
    }
  }

  /** 行变了：重新摊平一遍发出去，状态顺带对一下 */
  const publish = (tree: Tree) => {
    store.batch(() => {
      store.set(
        fileKeys.rows(tree.deviceId, tree.root),
        flattenTree(tree.root, tree.listings, tree.expanded, showHidden),
      )
      publishState(tree)
    })
  }

  /** 取一层。取到了是 true。这一层之前有内容的话，取的时候照旧显示 */
  const load = (tree: Tree, path: string, fresh: boolean): Promise<boolean> => {
    const before = tree.listings.get(path)
    const mine = ++seq
    tree.latest.set(path, mine)
    tree.listings.set(path, { state: 'loading', view: before?.view ?? null, error: null })
    // 之前没有内容：先把“正在取”那一行画出来
    if (!before?.view) publish(tree)
    return channel
      .command('files.list', {
        deviceId: tree.deviceId,
        root: tree.root,
        path,
        ...(fresh ? { fresh: true } : {}),
      })
      .then(
        (view) => {
          if (tree.latest.get(path) !== mine) return true
          const same = sameView(before?.view ?? null, view)
          // 内容没变就留着原来那份：行不用重算，界面也不用重画
          tree.listings.set(path, {
            state: 'ready',
            view: same ? (before?.view ?? view) : view,
            error: null,
          })
          if (!same) publish(tree)
          return true
        },
        (error: unknown) => {
          if (tree.latest.get(path) !== mine) return false
          const shape: ChannelErrorShape = toChannelError(error).toShape()
          // 取消的不算没取到：有旧内容就照旧，没有就还是“正在取”
          if (shape.code === 'cancelled') {
            tree.listings.set(path, before ?? { state: 'loading', view: null, error: null })
            return false
          }
          tree.listings.set(path, { state: 'failed', view: null, error: shape })
          publish(tree)
          return false
        },
      )
  }

  /** 现在看得见的目录：根，和一路展开下来的那些 */
  const visibleDirs = (tree: Tree, from = tree.root): string[] => {
    const out: string[] = []
    const walk = (dir: string) => {
      out.push(dir)
      const view = tree.listings.get(dir)?.view
      if (!view) return
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      for (const entry of view.entries) {
        if (entry.kind !== 'dir') continue
        const path = prefix + entry.name
        if (tree.expanded.has(path)) walk(path)
      }
    }
    walk(from)
    return out
  }

  const reloadVisible = async (tree: Tree, fresh: boolean, from = tree.root): Promise<void> => {
    tree.refreshing++
    // 只是“正在刷新”变了，行没变：各层取到了不一样的内容，load 自己会发
    publishState(tree)
    try {
      // 一层一层往下：上一层取到了才知道下面哪些还在
      const seen = new Set<string>()
      for (;;) {
        const todo = visibleDirs(tree, from).filter((dir) => !seen.has(dir))
        if (todo.length === 0) break
        for (const dir of todo) seen.add(dir)
        await Promise.all(todo.map((dir) => load(tree, dir, fresh)))
      }
    } finally {
      tree.refreshing--
      publishState(tree)
    }
  }

  return {
    open(deviceId, root) {
      const tree = treeOf(deviceId, root)
      tree.watchers++
      // 第一次看：只取根。再回来看：把展开着的各层对一遍（刚取过的核心会直接给缓存）
      if (tree.listings.has(tree.root)) void reloadVisible(tree, false)
      else void load(tree, tree.root, false)
      let closed = false
      return () => {
        if (closed) return
        closed = true
        tree.watchers--
      }
    },

    expand(deviceId, root, path) {
      const tree = treeOf(deviceId, root)
      const dir = normalizePath(path)
      if (dir === tree.root || !insideRoot(tree.root, dir) || tree.expanded.has(dir)) return
      tree.expanded.add(dir)
      // 以前展开过的：它下面还记着展开的那些也一起对一遍
      if (tree.listings.get(dir)?.view) {
        publish(tree)
        void reloadVisible(tree, false, dir)
      } else void load(tree, dir, false)
    },

    collapse(deviceId, root, path) {
      const tree = treeOf(deviceId, root)
      if (tree.expanded.delete(normalizePath(path))) publish(tree)
    },

    async reveal(deviceId, root, path) {
      const tree = treeOf(deviceId, root)
      const target = normalizePath(path)
      if (!insideRoot(tree.root, target)) return false
      const chain: string[] = []
      for (let dir = parentPath(target); dir && dir !== tree.root; dir = parentPath(dir)) {
        if (!insideRoot(tree.root, dir)) return false
        chain.unshift(dir)
      }
      for (const dir of [tree.root, ...chain]) {
        if (dir !== tree.root) tree.expanded.add(dir)
        if (!tree.listings.get(dir)?.view && !(await load(tree, dir, false))) {
          publish(tree)
          return false
        }
      }
      publish(tree)
      return true
    },

    refresh(deviceId, root) {
      return reloadVisible(treeOf(deviceId, root), true)
    },

    setShowHidden(show) {
      if (show === showHidden) return
      showHidden = show
      store.batch(() => {
        store.set(fileKeys.showHidden, show)
        for (const tree of trees.values()) {
          if (tree.listings.size > 0) publish(tree)
        }
      })
    },

    reconnected(deviceId) {
      for (const tree of trees.values()) {
        if (tree.deviceId === deviceId && tree.watchers > 0) void reloadVisible(tree, true)
      }
    },

    drop(deviceId) {
      for (const [key, tree] of trees) {
        if (tree.deviceId === deviceId) trees.delete(key)
      }
      store.deletePrefix(`files:${deviceId}:`)
    },
  }
}
