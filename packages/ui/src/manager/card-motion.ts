// 看板卡片的过渡：展开收起、提交后离开、新卡插入都只做视觉过渡，状态和焦点照常立刻生效。
// 做法一份：列表在渲染时（DOM 还是旧的）量一遍卡片，提交后对比新旧几何，
// 高度变了的卡做高度过渡，离开的卡放回原处收拢淡出，新来的卡展开淡入；下方的卡跟着布局自然移动。
// 偏好减少动态时一律不做，只保留让被点的卡留在原处的滚动补偿。
import { type RefObject, useLayoutEffect, useRef } from 'react'

/** 过渡时长（毫秒）：克制，150–250 之间 */
export const MOTION_MS = 200
const EASE = 'cubic-bezier(0.2, 0, 0, 1)'

export type Box = { top: number; height: number }
export type MotionPlan = {
  resize: { key: string; from: number; to: number }[]
  exit: string[]
  enter: string[]
}

/**
 * 新旧几何的差：只管落在可视区里的变化（可视区外的照常瞬时完成，浏览器的滚动锚定会稳住画面）。
 * 前后没有共同的卡（换了页签、筛选）或者共同的卡换了先后（改了排序），不做过渡。
 */
export function planCardMotion(
  before: readonly (readonly [string, Box])[],
  after: readonly (readonly [string, Box])[],
  view: { top: number; bottom: number },
): MotionPlan | null {
  const old = new Map(before)
  const next = new Map(after)
  const kept = after.filter(([key]) => old.has(key)).map(([key]) => key)
  const keptBefore = before.filter(([key]) => next.has(key)).map(([key]) => key)
  if (!kept.length || kept.some((key, i) => key !== keptBefore[i])) return null
  const seen = (box: Box) => box.top < view.bottom && box.top + box.height > view.top
  const plan: MotionPlan = { resize: [], exit: [], enter: [] }
  for (const [key, box] of before) if (!next.has(key) && seen(box)) plan.exit.push(key)
  for (const [key, box] of after) {
    const was = old.get(key)
    if (!was) {
      if (seen(box)) plan.enter.push(key)
    } else if (Math.abs(was.height - box.height) > 1 && (seen(was) || seen(box)))
      plan.resize.push({ key, from: was.height, to: box.height })
  }
  return plan.resize.length || plan.exit.length || plan.enter.length ? plan : null
}

/** 展开后露出的部分不到可视区一半、又没整张露出时，滚多少能让它尽量看全（卡头不越过可视区顶端） */
export function revealOffset(card: Box, view: { top: number; bottom: number }): number {
  const margin = 8
  if (card.top < view.top) return card.top - view.top - margin
  const shown = Math.min(card.top + card.height, view.bottom) - card.top
  const height = view.bottom - view.top
  if (shown >= card.height || shown >= height / 2) return 0
  return Math.max(
    0,
    Math.min(card.top + card.height - view.bottom + margin, card.top - view.top - margin),
  )
}

export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 卡片所在的滚动容器 */
export function scrollHost(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
  }
  return null
}

const viewOf = (host: HTMLElement | null) => {
  const rect = host?.getBoundingClientRect()
  return rect
    ? { top: rect.top, bottom: rect.bottom }
    : { top: 0, bottom: typeof innerHeight === 'number' ? innerHeight : 0 }
}

/**
 * 刚展开的卡大半落在可视区外时，滚到能看见（偏好减少动态时直接跳过去）。
 * scrolled 是过渡开始时的滚动位置：用户在过渡期间自己滚过，就不再自动滚动。
 */
export function reveal(element: HTMLElement, scrolled?: number) {
  const host = scrollHost(element)
  if (!host || (scrolled !== undefined && Math.abs(host.scrollTop - scrolled) > 1)) return
  const rect = element.getBoundingClientRect()
  const offset = revealOffset({ top: rect.top, height: rect.height }, viewOf(host))
  if (offset) host.scrollBy({ top: offset, behavior: reducedMotion() ? 'auto' : 'smooth' })
}

/** 一张卡从旧高度过渡到新高度；过渡期间裁掉溢出，结束后撤掉临时样式 */
export function animateHeight(element: HTMLElement, from: number, to: number): Animation | null {
  if (reducedMotion() || Math.abs(from - to) <= 1 || typeof element.animate !== 'function')
    return null
  for (const running of element.getAnimations()) running.cancel()
  const overflow = element.style.overflow
  element.style.overflow = 'hidden'
  const animation = element.animate([{ height: `${from}px` }, { height: `${to}px` }], {
    duration: MOTION_MS,
    easing: EASE,
  })
  const restore = () => {
    element.style.overflow = overflow
  }
  animation.addEventListener('finish', restore)
  animation.addEventListener('cancel', restore)
  return animation
}

/** 列表行距（flex 的 gap） */
const gapOf = (root: HTMLElement) => Number.parseFloat(getComputedStyle(root).rowGap) || 0

/**
 * 收拢：底边往上收、下边距同步变负，下方的卡同速上移补位。
 * 不动高度和内边距，所以离开的卡（放回去的旧节点）和新来的卡都能用。
 */
function fold(element: HTMLElement, height: number, gap: number, closing: boolean): Animation {
  const margin = Number.parseFloat(getComputedStyle(element).marginBottom) || 0
  const open = { opacity: 1, clipPath: 'inset(0 0 0 0)', marginBottom: `${margin}px` }
  const shut = {
    opacity: 0,
    clipPath: `inset(0 0 ${height}px 0)`,
    marginBottom: `${margin - height - gap}px`,
  }
  return element.animate(closing ? [open, shut] : [shut, open], {
    duration: MOTION_MS,
    easing: EASE,
  })
}

type Snapshot = {
  boxes: [string, Box][]
  nodes: Map<string, { node: HTMLElement; next: Element | null }>
  view: { top: number; bottom: number }
}

function measure(root: HTMLElement): Snapshot {
  const boxes: [string, Box][] = []
  const nodes: Snapshot['nodes'] = new Map()
  for (const node of root.querySelectorAll<HTMLElement>(':scope > [data-motion-key]')) {
    const key = node.dataset.motionKey
    if (!key) continue
    const rect = node.getBoundingClientRect()
    boxes.push([key, { top: rect.top, height: rect.height }])
    nodes.set(key, { node, next: node.nextElementSibling })
  }
  return { boxes, nodes, view: viewOf(scrollHost(root)) }
}

/** 放回原处收拢的旧节点：不可交互、读屏跳过，去掉标识免得被当成还在的卡查到 */
function ghostOf(node: HTMLElement): HTMLElement {
  for (const name of node.getAttributeNames())
    if (name.startsWith('data-')) node.removeAttribute(name)
  for (const inner of node.querySelectorAll('[id], [data-act], [data-testid]')) {
    inner.removeAttribute('id')
    inner.removeAttribute('data-act')
    inner.removeAttribute('data-testid')
  }
  node.dataset.motionGhost = ''
  node.inert = true
  node.setAttribute('aria-hidden', 'true')
  node.style.pointerEvents = 'none'
  return node
}

function play(root: HTMLElement, before: Snapshot, anchor: string | null) {
  for (const ghost of root.querySelectorAll(':scope > [data-motion-ghost]')) ghost.remove()
  const after = measure(root)
  const host = scrollHost(root)
  const plan = reducedMotion() ? null : planCardMotion(before.boxes, after.boxes, before.view)
  const running: Animation[] = []
  if (plan) {
    const gap = gapOf(root)
    const old = new Map(before.boxes)
    const now = new Map(after.boxes)
    for (const { key, from, to } of plan.resize) {
      const node = after.nodes.get(key)?.node
      const animation = node ? animateHeight(node, from, to) : null
      if (animation) running.push(animation)
    }
    // 倒着放回：连着离开的几张，后一张先回到原处，前一张就能插在它前面
    for (const key of [...plan.exit].reverse()) {
      const was = before.nodes.get(key)
      const height = old.get(key)?.height
      if (!was || height === undefined || was.node.isConnected) continue
      if (was.next === null) root.append(was.node)
      else if (was.next.isConnected && was.next.parentElement === root)
        root.insertBefore(was.node, was.next)
      else continue
      const ghost = ghostOf(was.node)
      const animation = fold(ghost, height, gap, true)
      const drop = () => ghost.remove()
      animation.addEventListener('finish', drop)
      animation.addEventListener('cancel', drop)
      running.push(animation)
    }
    for (const key of plan.enter) {
      const node = after.nodes.get(key)?.node
      const height = now.get(key)?.height
      if (node && height !== undefined) running.push(fold(node, height, gap, false))
    }
  }
  const node = anchor ? after.nodes.get(anchor)?.node : undefined
  const from = before.boxes.find(([key]) => key === anchor)?.[1]
  const cancel = () => {
    for (const animation of running) animation.cancel()
  }
  if (!node || !from || !host) return cancel
  // 被点的卡留在原处：其他卡收起或展开时逐帧补偿滚动，接管期间关掉浏览器自带的滚动锚定免得补两次
  /** 最近一次补偿后的滚动位置：和它对不上说明用户自己滚了，停止补偿 */
  let held = host.scrollTop
  let live = true
  const hold = () => {
    if (!live) return
    if (Math.abs(host.scrollTop - held) > 1) {
      live = false
      return
    }
    const drift = node.getBoundingClientRect().top - from.top
    if (Math.abs(drift) > 0.5) host.scrollTop += drift
    held = host.scrollTop
  }
  const grown = (new Map(after.boxes).get(anchor ?? '')?.height ?? 0) > from.height + 1
  const settle = () => {
    if (grown && live) reveal(node)
  }
  hold()
  if (!running.length) {
    settle()
    return
  }
  const anchoring = host.style.overflowAnchor
  host.style.overflowAnchor = 'none'
  let done = false
  const tick = () => {
    if (done) return
    hold()
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  void Promise.allSettled(running.map((animation) => animation.finished)).then(() => {
    if (done) return
    done = true
    hold()
    host.style.overflowAnchor = anchoring
    settle()
  })
  return () => {
    done = true
    live = false
    host.style.overflowAnchor = anchoring
    cancel()
  }
}

/**
 * 列表过渡：root 的直接子元素里带 data-motion-key 的是卡片。
 * scope 变了（换页签、换筛选）不做过渡；signature 变了（卡片增减、展开哪张、详情到了）才量和比。
 * anchor 由点击处写入，这一轮让那张卡留在原处。
 */
export function useCardMotion(
  root: RefObject<HTMLElement | null>,
  scope: string,
  signature: string,
  anchor?: { current: string | null },
  enabled = true,
) {
  const last = useRef<{ scope: string; signature: string } | null>(null)
  const pending = useRef<Snapshot | null>(null)
  const stop = useRef<(() => void) | undefined>(undefined)
  const previous = last.current
  if (!previous || previous.scope !== scope || previous.signature !== signature) {
    // 渲染时 DOM 还是上一版：在这里量旧几何（只读，重复渲染也无妨）
    pending.current =
      enabled && previous?.scope === scope && root.current ? measure(root.current) : null
    last.current = { scope, signature }
  }
  useLayoutEffect(() => {
    if (!enabled) {
      pending.current = null
      last.current = null
    }
    const snapshot = pending.current
    const held = anchor?.current ?? null
    pending.current = null
    if (anchor) anchor.current = null
    if (snapshot && root.current) {
      stop.current?.()
      stop.current = play(root.current, snapshot, held)
    }
  })
  // 切页签和卸载时结束旧补偿，不能在新页签恢复后继续修改共用滚动容器。
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope 是过渡的归属，不是回调内读取的数据。
  useLayoutEffect(
    () => () => {
      stop.current?.()
      stop.current = undefined
    },
    [scope],
  )
}

/** 整卡点击里不算开合的部分：控件、链接、可编辑区和显式排除的元素 */
const INTERACTIVE =
  'a, button, input, textarea, select, label, summary, [role="button"], [role="link"], [role="radio"], [role="checkbox"], [role="menuitem"], [role="tab"], [contenteditable]:not([contenteditable="false"]), [data-card-click="ignore"]'

type ClickLike = {
  button: number
  detail: number
  target: unknown
  clientX: number
  clientY: number
}
type SelectionLike = {
  isCollapsed: boolean
  anchorNode: unknown
  focusNode: unknown
  toString(): string
}
type Container = { contains(node: unknown): boolean }

/**
 * 点在卡片空白处才开合：点到控件、拖动过、双击选词、卡里选着文字都不算。
 * 键盘由卡头按钮负责（Enter、空格，带 aria-expanded），整卡点击只是鼠标的便利。
 */
export function wholeCardClick(
  event: ClickLike,
  card: Container,
  press: { x: number; y: number } | null,
  selection: SelectionLike | null,
): boolean {
  if (event.button !== 0 || event.detail > 1) return false
  const target = event.target as { closest?(selector: string): unknown } | null
  const hit = typeof target?.closest === 'function' ? target.closest(INTERACTIVE) : null
  if (hit && card.contains(hit)) return false
  if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) return false
  if (
    selection &&
    !selection.isCollapsed &&
    selection.toString().trim() &&
    (card.contains(selection.anchorNode) || card.contains(selection.focusNode))
  )
    return false
  return true
}

/** 整卡点击的事件处理：一份按下位置，返回给每张卡生成处理函数；toggle 只在 wholeCardClick 认可时调用 */
export function useCardPress() {
  const press = useRef<{ x: number; y: number } | null>(null)
  return (toggle: () => void) => ({
    onPointerDown(event: { clientX: number; clientY: number }) {
      press.current = { x: event.clientX, y: event.clientY }
    },
    onClick(event: ClickLike & { currentTarget: Container }) {
      const selection = typeof getSelection === 'function' ? getSelection() : null
      if (wholeCardClick(event, event.currentTarget, press.current, selection)) toggle()
      press.current = null
    },
  })
}
