// 文件标签在界面这一头记的东西，按“哪台设备上的哪个根”各记一份，只在这次运行里有效：
// 选中的是哪一行、树滚到哪了、开着哪些文件（哪个是预览、正看着哪个、要定位到哪一行）。
// 展开着哪些目录不在这里：那在数据副本里（核心的 replica/file-trees.mts）。
// 这个文件不碰页面上的元素，只管数：预览和固定的规矩在这里，好单独测。
import { useSyncExternalStore } from 'react'
import { showSideTab } from '../side/side.ts'
import { FILES_TAB } from '../side/tabs.ts'

export interface OpenFile {
  path: string
  /** 固定了没有。没固定的是预览：再点开别的文件，它就被换掉 */
  pinned: boolean
  /** 要定位到的行（从 1 起）。没有是 null */
  line: number | null
  /** 每要求定位一次加一：同一行再点一次也要重新滚过去 */
  jump: number
  /** 这个路径读不到的时候再试的另一个（对话里相对路径的另一种读法）。试过就清掉 */
  alt: string | null
}

export interface TreeUi {
  /** 树里选中的那一行的路径 */
  selected: string | null
  /** 开着的文件，从左到右 */
  tabs: readonly OpenFile[]
  /** 正看着的那个文件的路径 */
  active: string | null
  /** 要在树里露出来的路径（从对话里、从找文件的结果里点开的）。树定位到了就清掉 */
  reveal: string | null
}

const EMPTY: TreeUi = { selected: null, tabs: [], active: null, reveal: null }

const trees = new Map<string, TreeUi>()
const listeners = new Map<string, Set<() => void>>()

/** 一棵树的标识：哪台设备上的哪个根 */
export const treeKey = (deviceId: string, root: string): string => `${deviceId}\n${root}`

export const treeUiNow = (key: string): TreeUi => trees.get(key) ?? EMPTY

const publish = (key: string, next: TreeUi) => {
  trees.set(key, next)
  for (const listener of listeners.get(key) ?? []) listener()
}

export function useTreeUi(key: string): TreeUi {
  return useSyncExternalStore(
    (listener) => {
      const set = listeners.get(key) ?? new Set()
      listeners.set(key, set)
      set.add(listener)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(key)
      }
    },
    () => treeUiNow(key),
  )
}

export function selectPath(key: string, path: string | null): void {
  const ui = treeUiNow(key)
  if (ui.selected !== path) publish(key, { ...ui, selected: path })
}

export interface OpenOptions {
  /** 固定打开（双击、回车）。不给就是预览 */
  pin?: boolean
  /** 定位到这一行 */
  line?: number | null
  alt?: string | null
  /** 顺带在树里把它露出来 */
  reveal?: boolean
}

/**
 * 打开一个文件。已经开着就换过去（要求固定的顺手固定）；没开着的，预览会换掉现有的那个预览标签，
 * 固定的排到最后。
 */
export function openFile(key: string, path: string, options: OpenOptions = {}): void {
  const ui = treeUiNow(key)
  const pin = options.pin === true
  const line = options.line ?? null
  const at = ui.tabs.findIndex((tab) => tab.path === path)
  let tabs: OpenFile[]
  if (at >= 0) {
    tabs = ui.tabs.map((tab, index) =>
      index === at
        ? {
            ...tab,
            pinned: tab.pinned || pin,
            line: line ?? tab.line,
            jump: line === null ? tab.jump : tab.jump + 1,
          }
        : tab,
    )
  } else {
    const fresh: OpenFile = {
      path,
      pinned: pin,
      line,
      jump: line === null ? 0 : 1,
      alt: options.alt ?? null,
    }
    const preview = ui.tabs.findIndex((tab) => !tab.pinned)
    // 预览只有一个位置：新的预览顶掉旧的；固定打开的不动那个预览
    tabs = pin || preview < 0 ? [...ui.tabs, fresh] : ui.tabs.with(preview, fresh)
  }
  publish(key, {
    selected: path,
    tabs,
    active: path,
    reveal: options.reveal ? path : ui.reveal,
  })
}

/** 把预览固定下来 */
export function pinFile(key: string, path: string): void {
  const ui = treeUiNow(key)
  if (!ui.tabs.some((tab) => tab.path === path && !tab.pinned)) return
  publish(key, {
    ...ui,
    tabs: ui.tabs.map((tab) => (tab.path === path ? { ...tab, pinned: true } : tab)),
  })
}

export function activateFile(key: string, path: string): void {
  const ui = treeUiNow(key)
  if (ui.active === path || !ui.tabs.some((tab) => tab.path === path)) return
  publish(key, { ...ui, active: path, selected: path })
}

/** 关掉一个文件。关的是正看着的那个，就换到它右边的；右边没有就换到左边的 */
export function closeFile(key: string, path: string): void {
  const ui = treeUiNow(key)
  const at = ui.tabs.findIndex((tab) => tab.path === path)
  if (at < 0) return
  const tabs = ui.tabs.filter((tab) => tab.path !== path)
  const active = ui.active === path ? ((tabs[at] ?? tabs[at - 1])?.path ?? null) : ui.active
  publish(key, { ...ui, tabs, active })
}

/** 这个路径读不到，换成它的另一种读法再试。标签的位置和固定与否不变 */
export function retargetFile(key: string, from: string, to: string): void {
  const ui = treeUiNow(key)
  if (!ui.tabs.some((tab) => tab.path === from)) return
  // 另一种读法已经开着：直接换过去，读不到的那个关掉
  if (ui.tabs.some((tab) => tab.path === to)) {
    const tabs = ui.tabs.filter((tab) => tab.path !== from)
    publish(key, {
      ...ui,
      tabs,
      active: to,
      selected: to,
      reveal: ui.reveal === from ? to : ui.reveal,
    })
    return
  }
  publish(key, {
    selected: ui.selected === from ? to : ui.selected,
    tabs: ui.tabs.map((tab) => (tab.path === from ? { ...tab, path: to, alt: null } : tab)),
    active: ui.active === from ? to : ui.active,
    reveal: ui.reveal === from ? to : ui.reveal,
  })
}

/** 要在树里把这个路径露出来（不开文件）。打开的是个目录的时候用 */
export function revealPath(key: string, path: string): void {
  publish(key, { ...treeUiNow(key), selected: path, reveal: path })
}

export function clearReveal(key: string, path: string): void {
  const ui = treeUiNow(key)
  if (ui.reveal === path) publish(key, { ...ui, reveal: null })
}

// ---------- 滚到哪了 ----------
// 不用通知谁：离开的时候记一笔，回来的时候读一次

const treeScroll = new Map<string, number>()
const viewScroll = new Map<string, number>()
/** 文件的滚动位置最多记这么多个，多了从最早的丢 */
const VIEW_SCROLL_MAX = 200

export const rememberTreeScroll = (key: string, top: number): void => {
  treeScroll.set(key, top)
}

export const treeScrollOf = (key: string): number => treeScroll.get(key) ?? 0

export function rememberViewScroll(key: string, path: string, top: number): void {
  const id = `${key}\n${path}`
  viewScroll.delete(id)
  viewScroll.set(id, top)
  if (viewScroll.size <= VIEW_SCROLL_MAX) return
  const oldest = viewScroll.keys().next().value
  if (oldest !== undefined) viewScroll.delete(oldest)
}

export const viewScrollOf = (key: string, path: string): number =>
  viewScroll.get(`${key}\n${path}`) ?? 0

// ---------- 一个工作区有几个根的时候，看的是哪一个 ----------

const pickedRoots = new Map<string, string>()
const rootListeners = new Set<() => void>()
let rootVersion = 0

const placeKey = (deviceId: string, workspaceId: string | null): string =>
  `${deviceId}\n${workspaceId ?? ''}`

export function pickRoot(deviceId: string, workspaceId: string | null, root: string): void {
  const key = placeKey(deviceId, workspaceId)
  if (pickedRoots.get(key) === root) return
  pickedRoots.set(key, root)
  rootVersion++
  for (const listener of rootListeners) listener()
}

/** 这个地方上次看的是哪个根。没挑过、或者挑的那个已经不在了，就是第一个 */
export function usePickedRoot(
  deviceId: string,
  workspaceId: string | null,
  roots: readonly string[],
): string | null {
  useSyncExternalStore(
    (listener) => {
      rootListeners.add(listener)
      return () => {
        rootListeners.delete(listener)
      }
    },
    () => rootVersion,
  )
  const picked = pickedRoots.get(placeKey(deviceId, workspaceId))
  return picked !== undefined && roots.includes(picked) ? picked : (roots[0] ?? null)
}

// ---------- 别处要“在文件面板里打开这个文件” ----------

export interface FileTarget {
  deviceId: string
  workspaceId: string | null
  /** 文件在哪个根下面 */
  root: string
  path: string
  alt?: string | null
  line?: number | null
}

/** 打开侧面板的文件标签，在里面预览这个文件、定位到那一行，并且在树里把它露出来 */
export function openInFiles(target: FileTarget): void {
  showSideTab(FILES_TAB)
  pickRoot(target.deviceId, target.workspaceId, target.root)
  openFile(treeKey(target.deviceId, target.root), target.path, {
    line: target.line ?? null,
    alt: target.alt ?? null,
    reveal: true,
  })
}

// ---------- 树那一栏多宽 ----------
// 和面板的宽度一样记在这台电脑的界面里

const WIDTH_KEY = 'litch.files'
export const TREE_MIN = 140
export const TREE_DEFAULT = 200
/** 右边的文件内容至少留这么宽 */
const VIEW_MIN = 160

function readTreeWidth(): number {
  try {
    const parsed = JSON.parse(localStorage.getItem(WIDTH_KEY) ?? '{}') as { tree?: unknown }
    return typeof parsed.tree === 'number' && Number.isFinite(parsed.tree)
      ? Math.max(TREE_MIN, Math.round(parsed.tree))
      : TREE_DEFAULT
  } catch {
    return TREE_DEFAULT
  }
}

let treeWidth = readTreeWidth()
const widthListeners = new Set<() => void>()

export const useTreeWidth = (): number =>
  useSyncExternalStore(
    (listener) => {
      widthListeners.add(listener)
      return () => {
        widthListeners.delete(listener)
      }
    },
    () => treeWidth,
  )

/** room：文件标签一共多宽。树不能把右边的内容挤没 */
export const clampTreeWidth = (width: number, room: number): number =>
  Math.round(Math.min(Math.max(width, TREE_MIN), Math.max(TREE_MIN, room - VIEW_MIN)))

export function setTreeWidth(width: number): void {
  const next = Math.max(TREE_MIN, Math.round(width))
  if (next === treeWidth) return
  treeWidth = next
  try {
    localStorage.setItem(WIDTH_KEY, JSON.stringify({ tree: next }))
  } catch {
    // 记不下来不影响这一次
  }
  for (const listener of widthListeners) listener()
}
