// 右边常驻的信息栏：放一些小而常看的东西，有内容就自己出来，没有就不占地方。
// 和文件、浏览器那种要手动打开的侧面板不是一回事：它排在对话和侧面板之间，跟着眼前的会话走。
// 眼下两张卡片：会话最近的一份待办（各家 harness 的待办都经协议里的“回合计划更新”过来），
// 和会话所在的工作树（在设备层建的工作树里才有）。
// 窗口窄到放下它对话就太挤的时候整栏不出，待办回到对话里（见 rail-state.ts）；用户也能从标题栏上把它收起来（RailToggle）。
import {
  type ItemView,
  keys,
  type SessionSummary,
  type TodoItem,
  type TurnView,
  todoKey,
} from '@litch/core'
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Caret, Icon } from '../app/icons.tsx'
import { useKey, useKeys } from '../app/services.tsx'
import { useToggle } from '../transcript/state.ts'
import { TodoBar, TodoSteps, todoProgress } from '../transcript/Todo.tsx'
import { RailWorktree } from '../worktrees/RailWorktree.tsx'
import {
  setRailAvailable,
  setRailTodo,
  toggleRail,
  useRailAllowed,
  useRailAvailable,
  useRailOpen,
} from './rail-state.ts'

/** 信息栏的宽度，和样式里 .rail 的一致 */
const RAIL_WIDTH = 280
/** 对话那一栏至少留这么宽，不够就不出信息栏 */
const MIN_MAIN = 520

interface InfoRailProps {
  deviceId: string
  sessionId: string
}

/** 会话里最近的一份待办，和它所在的回合 */
function useLatestTodo(deviceId: string, sessionId: string) {
  const turnIds = useKey<string[]>(keys.turnIds(deviceId, sessionId))
  const todoKeys = useMemo(
    () => (turnIds ?? []).map((turnId) => keys.item(deviceId, sessionId, todoKey(turnId))),
    [deviceId, sessionId, turnIds],
  )
  const values = useKeys<ItemView>(todoKeys)
  let at = values.length - 1
  while (at >= 0) {
    const value = values[at]
    if (value?.kind === 'todo' && value.steps.length > 0) break
    at--
  }
  const item = at >= 0 ? (values[at] as TodoItem) : null
  const turnId = at >= 0 ? (turnIds?.[at] ?? '') : ''
  const turn = useKey<TurnView>(keys.turn(deviceId, sessionId, turnId))
  return { item, running: turn?.status === 'running' }
}

/** 对话那一栏加上信息栏一共有多宽，够不够放下信息栏 */
function useFits(rail: RefObject<HTMLElement | null>): boolean {
  const [fits, setFits] = useState(true)
  useEffect(() => {
    const main = document.querySelector<HTMLElement>('.body > .main')
    if (!main) return
    // 信息栏出不出，两栏加起来的宽度都一样，不会来回跳
    const measure = () => {
      const shown = rail.current?.getBoundingClientRect().width ?? 0
      setFits(main.getBoundingClientRect().width + shown >= MIN_MAIN + RAIL_WIDTH)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(main)
    return () => observer.disconnect()
  }, [rail])
  return fits
}

export function InfoRail({ deviceId, sessionId }: InfoRailProps) {
  const t = useT()
  const sessionKey = `${deviceId}:${sessionId}`
  const rail = useRef<HTMLElement | null>(null)
  const fits = useFits(rail)
  const { item, running } = useLatestTodo(deviceId, sessionId)
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const worktree = summary?.worktree ?? null
  const allowed = useRailAllowed()
  const open = useRailOpen()
  const available = allowed && fits && (item !== null || worktree !== null)
  // 用户收起了：整栏不出、不占宽度，待办回到对话里；标题栏上的开关还在，点了再出来
  const show = available && open
  const todoShown = show && item !== null
  useEffect(() => {
    setRailTodo(todoShown ? sessionKey : null)
    return () => setRailTodo(null)
  }, [todoShown, sessionKey])
  useEffect(() => {
    setRailAvailable(available)
    return () => setRailAvailable(false)
  }, [available])
  if (!show) return null
  return (
    <aside className="rail" ref={rail} aria-label={t('rail.label')}>
      {worktree ? (
        <RailWorktree deviceId={deviceId} sessionKey={sessionKey} worktree={worktree} />
      ) : null}
      {item ? <RailTodo sessionKey={sessionKey} item={item} running={running} /> : null}
    </aside>
  )
}

/** 待办卡片：标题一行（名字、箭头，右边是进度摘要）能点开收起；全做完了、回合也结束了，默认收着，只留“已完成 N/N” */
function RailTodo({
  sessionKey,
  item,
  running,
}: {
  sessionKey: string
  item: TodoItem
  running: boolean
}) {
  const t = useT()
  const { done, total } = todoProgress(item)
  const finished = done === total && !running
  const [open, setOpen] = useToggle(sessionKey, 'rail:todo', !finished)
  return (
    <section className="rail-card rail-todo" data-open={open ? '' : undefined}>
      <button
        type="button"
        className="rail-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="rail-title">{t('todo.title')}</span>
        <Caret />
        <span className="rail-sum">
          <span className="todo-count">{t('todo.count', { done, total })}</span>
          <TodoBar done={done} total={total} />
        </span>
      </button>
      {open ? (
        <div className="rail-body">
          <TodoSteps item={item} />
        </div>
      ) : null}
    </section>
  )
}

/** 标题栏上开合信息栏的按钮。栏里没东西、窗口放不下的时候没有 */
export function RailToggle() {
  const t = useT()
  const open = useRailOpen()
  if (!useRailAvailable()) return null
  return (
    <button
      type="button"
      className="ibtn tb-rail"
      title={t('rail.toggle')}
      aria-label={t('rail.toggle')}
      aria-pressed={open}
      onClick={toggleRail}
    >
      <Icon name="rail" />
    </button>
  )
}
