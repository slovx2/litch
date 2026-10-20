import {
  type DeviceView,
  groupOfSection,
  keys,
  LOOSE,
  PINNED,
  pathTwin,
  type SectionView,
  type SessionChildren,
  type SessionGroups,
  type SessionHarnesses,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'
import {
  type CSSProperties,
  type DragEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { Draft, Page, Selection } from '../app/App.tsx'
import { requestTasks } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { useNow } from '../app/clock.ts'
import { badgeOf, downHarness, downText, nameOf, wireStyle } from '../app/device.ts'
import { reasonOf } from '../app/errors.ts'
import { ago } from '../app/format.ts'
import { useHoverCard } from '../app/HoverCard.tsx'
import {
  Archive,
  Back,
  Caret,
  Clock,
  Forward,
  Gear,
  Icon,
  Machine,
  Notice,
  Plus,
} from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import type { PlaceWish } from '../composer/new-place.ts'
import { PairDialog } from '../devices/PairDialog.tsx'
import { FailureNote, shownState, useReconnect } from '../devices/status.tsx'
import { useBrowserWants } from '../side/browser/store.ts'
import { SpawnDialog } from '../tree/SpawnDialog.tsx'
import { offerUndo } from './archive-undo.ts'
import { cwdMark } from './cwd.ts'
import {
  DRAG_TYPE,
  type DragItem,
  type DropTarget,
  draggedItem,
  dropCommands,
  endDrag,
  onDragChange,
  startDrag,
} from './drop.ts'
import { dropNativeChildren, keepSessions } from './filter.ts'
import { HarnessFilter } from './HarnessFilter.tsx'
import { DeviceInfo, SessionInfo, WorkspaceInfo } from './InfoCards.tsx'
import { type RowAction, RowMenu, type RowMenuHandle } from './RowMenu.tsx'
import { SectionDialog } from './SectionDialog.tsx'
import { SidebarFrame } from './SidebarFrame.tsx'
import { SidebarMore } from './SidebarMore.tsx'
import { useSidebarHarnesses, useSidebarNativeChildren } from './state.ts'
import { TallyMarks } from './TallyMarks.tsx'
import { WorkspaceDialog } from './WorkspaceDialog.tsx'

const NO_WORKSPACES: readonly WorkspaceView[] = []
const NO_SECTIONS: readonly SectionView[] = []
/** 菜单里“移到组”那一屏最后的“新建组…” */
const NEW_SECTION = ':new'

/** 现在正在拖的东西。拖起来、放下时叫醒订阅的组件 */
const useDragging = (): DragItem | null => useSyncExternalStore(onDragChange, draggedItem)

/** 拖起来：记下拖的是什么。dataTransfer 上只放个记号，好认出是侧栏里拖出来的 */
function beginDrag(event: DragEvent, item: DragItem) {
  event.dataTransfer.setData(DRAG_TYPE, item.id)
  event.dataTransfer.effectAllowed = 'move'
  startDrag(item)
}

interface RowProps {
  deviceId: string
  sessionId: string
  selected: boolean
  onSelect(selection: Selection): void
  /** 挂在父会话下面的子会话：行上只有状态点和名字，别的在信息卡里 */
  nested?: boolean
  /** 下面挂着几个子会话。有的话行首左边一个收起、展开的小箭头 */
  kids?: number
  folded?: boolean
  onFold?(): void
}

/** 一行会话。只订阅这一个会话的摘要：别的会话变了，这一行不重画 */
const SessionRow = memo(function SessionRow({
  deviceId,
  sessionId,
  selected,
  onSelect,
  nested = false,
  kids = 0,
  folded = false,
  onFold,
}: RowProps) {
  const { channel, replica } = useServices()
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId)) ?? NO_WORKSPACES
  const sections = useKey<SectionView[]>(keys.sections(deviceId)) ?? NO_SECTIONS
  const schedulable = useKey<boolean | null>(keys.tasksAvailable(deviceId)) === true
  const t = useT()
  const now = useNow()
  // 行上只有标题、徽标、时间；在哪个工作区、哪个目录、是不是置顶了这些在信息卡里
  const info = useHoverCard(() =>
    summary && device ? (
      <SessionInfo
        summary={summary}
        device={device}
        workspace={workspaces.find((entry) => entry.id === summary.workspaceId)}
      />
    ) : null,
  )
  /** 正在改名时输入框里的字。null：没在改 */
  const [naming, setNaming] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  /** 开着“派一个子会话”的对话框 */
  const [spawning, setSpawning] = useState(false)
  /** 开着“新建组”的对话框：建好之后把这个会话放进去 */
  const [grouping, setGrouping] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const menu = useRef<RowMenuHandle>(null)
  /** 这一次改名已经有了结果（提交或者放弃）。输入框消失时还会再报一次失焦，不能当成又提交一次 */
  const settled = useRef(true)
  const editing = naming !== null
  // 输入框一出现就全选，直接打字就是换一个名字
  useEffect(() => {
    if (!editing) return
    field.current?.focus()
    field.current?.select()
  }, [editing])
  if (!summary) return null

  const failed = (error: unknown) => setFailure(t('session.failed', { reason: reasonOf(error, t) }))
  /** 置顶、放进一个组，或者从置顶、从它所在的组里拿出来 */
  const place = (to: 'pinned' | { sectionId: string } | null) => {
    setFailure(null)
    channel.command('session.place', { deviceId, sessionId, place: to }).catch(failed)
  }
  const move = (workspaceId: string) => {
    setFailure(null)
    channel.command('session.move', { deviceId, sessionId, workspaceId }).catch(failed)
  }
  const run = (command: 'session.archive' | 'session.delete') => {
    setFailure(null)
    channel.command(command, { deviceId, sessionId }).then(() => {
      // 归档可以撤销：出一条提示，点一下就恢复（这一行这时已经不在了）
      if (command !== 'session.archive') return
      const shelved = { deviceId, sessionId, title: summary.title, reselect: selected }
      offerUndo(shelved, { channel, store: replica.store, select: onSelect })
    }, failed)
  }
  const rename = (commit: boolean) => {
    if (settled.current) return
    settled.current = true
    const title = (naming ?? '').trim()
    setNaming(null)
    if (!commit || !title || title === t.text(summary.title)) return
    setFailure(null)
    channel.command('session.rename', { deviceId, sessionId, title }).catch(failed)
  }
  if (naming !== null) {
    return (
      <div className="ss-row sel editing">
        <input
          ref={field}
          className="ss-name"
          value={naming}
          aria-label={t('session.nameLabel')}
          onChange={(event) => setNaming(event.target.value)}
          onBlur={() => rename(true)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') rename(true)
            else if (event.key === 'Escape') rename(false)
          }}
        />
      </div>
    )
  }
  const mark =
    summary.status === 'running'
      ? 'run'
      : summary.status === 'waiting'
        ? 'wait'
        : summary.status === 'error'
          ? 'err'
          : summary.unread
            ? 'unread'
            : ''
  // 工作目录不是它所在工作区的根（在子目录里开的，或者从别处挪进来的）：标题后面一个小记号。
  // 行上只有记号；是哪个目录在记号的提示和信息卡里
  const home = workspaces.find((entry) => entry.id === summary.workspaceId)
  const apart = cwdMark(summary.cwd, home?.roots, pathTwin(device?.os))
  const apartSaid = apart
    ? t(apart.kind === 'sub' ? 'session.cwd.sub' : 'session.cwd.away', { path: summary.cwd })
    : undefined
  // 所属的 harness 现在用不了：这一行是上次留下的。行上不加字，徽标换个画法，为什么用不了在提示和设备信息卡里
  const down = downHarness(device, summary.harness)
  const classes = [
    'ss-row',
    selected ? 'sel' : '',
    summary.unread ? 'is-unread' : '',
    down ? 'down' : '',
  ]
  // 改名、归档、删除、换工作区都要够得着它所属的 harness：设备没连着、或者那个 harness 用不了，都不出。
  // 它声明了自己不会的那几样也不出（没有声明的照旧都出）
  const online = device?.connection === 'online' && !down
  const can = device?.harnesses.find((entry) => entry.id === summary.harness)?.abilities
  // 置顶是设备上的记录，不用经过 harness：它用不了的时候也能做
  const organizable = device?.organizable === true
  const elsewhere = workspaces.filter((entry) => entry.id !== summary.workspaceId)
  const actions: RowAction[] = []
  if (organizable) {
    if (summary.pinned) actions.push({ id: 'unpin', title: t('session.unpin') })
    else {
      if (summary.section)
        actions.push({
          id: 'unsection',
          title: t('session.unsection', { name: summary.section.name }),
        })
      actions.push({ id: 'pin', title: t('session.pin') })
    }
    // 移到组：别的组，最后一项是新建一个
    actions.push({
      id: 'group',
      title: t('section.move'),
      choices: {
        title: t('section.move.title'),
        back: t('session.move.back'),
        options: [
          ...sections
            .filter((entry) => entry.id !== summary.section?.id || summary.pinned)
            .map((entry) => ({ id: entry.id, title: entry.name })),
          { id: NEW_SECTION, title: t('section.add') },
        ],
      },
    })
    if (online && elsewhere.length > 0)
      actions.push({
        id: 'move',
        title: t('session.move'),
        choices: {
          title: t('session.move.title'),
          back: t('session.move.back'),
          options: elsewhere.map((entry) => ({
            id: entry.id,
            title: entry.name,
            wire: entry.color,
          })),
        },
      })
  }
  // 为这个会话建定时任务：到点在这个会话里接着发。设备的服务要支持定时任务
  if (online && schedulable) actions.push({ id: 'schedule', title: t('tasks.forSession') })
  // 会话树是设备层的事：设备连着、声明了就能脱离，不用经过它所属的 harness；
  // 派子会话要读父会话（带上下文时还要分叉它），它的 harness 得可用
  if (device?.connection === 'online' && device.sessionTree) {
    if (online) actions.push({ id: 'spawn', title: t('tree.spawnMenu') })
    if (summary.lineage)
      actions.push({
        id: 'detach',
        title: t('tree.detach'),
        confirm: {
          title: t('tree.detach.title'),
          note: t('tree.detach.note'),
          yes: t('tree.detach.yes'),
          no: t('tree.dialog.cancel'),
        },
      })
  }
  if (online) {
    if (can?.rename !== false) actions.push({ id: 'rename', title: t('session.rename') })
    if (can?.archive !== false) actions.push({ id: 'archive', title: t('session.archive') })
    if (can?.remove !== false)
      actions.push({
        id: 'delete',
        title: t('session.delete'),
        confirm: {
          title: t('session.delete.title'),
          note: t('session.delete.note'),
          yes: t('session.delete'),
          no: t('permission.confirm.no'),
        },
      })
  }
  const act = (id: string, choice?: string) => {
    if (id === 'rename') {
      settled.current = false
      setNaming(t.text(summary.title))
    } else if (id === 'schedule') requestTasks({ view: 'new', deviceId, threadId: sessionId })
    else if (id === 'spawn') setSpawning(true)
    else if (id === 'detach') {
      setFailure(null)
      channel.command('session.detach', { deviceId, sessionId }).catch(failed)
    } else if (id === 'pin') place('pinned')
    else if (id === 'unpin' || id === 'unsection') place(null)
    else if (id === 'group') {
      if (choice === NEW_SECTION) setGrouping(true)
      else if (choice) place({ sectionId: choice })
    } else if (id === 'move') {
      if (choice) move(choice)
    } else run(id === 'archive' ? 'session.archive' : 'session.delete')
  }
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 右键出的菜单和行尾“更多”按钮是同一份，键盘走那个按钮 */}
      <div
        className="row-line"
        data-session={sessionId}
        data-parent={nested ? (summary.lineage?.parentId ?? '') : undefined}
        // 能整理的设备上可以拖：拖进置顶、组，或者拖回自己的项目（Sidebar 里的落点）
        draggable={organizable}
        onDragStart={(event) =>
          beginDrag(event, {
            deviceId,
            kind: 'session',
            id: sessionId,
            workspaceId: summary.workspaceId,
            pinned: summary.pinned,
            sectionId: summary.pinned ? null : (summary.section?.id ?? null),
          })
        }
        onDragEnd={endDrag}
        {...info.area}
        onContextMenu={(event) => {
          // 一件能做的事都没有（没连着）就不出菜单；在已经弹出来的菜单里点右键也不管
          if (actions.length === 0 || (event.target as Element).closest('.pick-pop')) return
          event.preventDefault()
          const box = event.currentTarget.getBoundingClientRect()
          // 用键盘叫出来的没有鼠标位置：弹在这一行下面
          const keyed = event.clientX === 0 && event.clientY === 0
          menu.current?.openAt(
            keyed ? box.left + 24 : event.clientX,
            keyed ? box.bottom : event.clientY,
          )
        }}
      >
        <button
          type="button"
          className={classes.filter(Boolean).join(' ')}
          aria-current={selected ? 'true' : undefined}
          onClick={() => onSelect({ deviceId, sessionId })}
          {...info.anchor}
        >
          <i className={mark ? `st ${mark}` : 'st'} />
          <span className="title ell grow">{t.text(summary.title)}</span>
          {nested ? null : apart ? (
            <span
              className="cwd-mark"
              role="img"
              data-cwd={apart.kind}
              title={apartSaid}
              aria-label={apartSaid}
            >
              <Icon name="folder" />
            </span>
          ) : null}
          {summary.task ? <TaskMark kind={summary.task.kind} /> : null}
          {nested ? null : (
            <>
              <BrowserWants deviceId={deviceId} sessionId={sessionId} />
              <span
                className={down ? 'chip off' : 'chip'}
                title={down ? downText(down, 'chip', t) : nameOf(device, summary.harness)}
              >
                {badgeOf(device, summary.harness)}
              </span>
              {summary.status === 'waiting' ? (
                <span className="pill wait">
                  {t(
                    summary.waitingFor === 'answer' ? 'sidebar.waitAnswer' : 'sidebar.waitApproval',
                  )}
                </span>
              ) : (
                <span className="time">{ago(summary.updatedAt, now, t)}</span>
              )}
            </>
          )}
        </button>
        {kids > 0 && onFold ? (
          <button
            type="button"
            className="tree-fold"
            aria-expanded={!folded}
            title={folded ? t('tree.unfold', { n: kids }) : t('tree.fold')}
            aria-label={folded ? t('tree.unfold', { n: kids }) : t('tree.fold')}
            onClick={onFold}
          >
            <Caret />
          </button>
        ) : null}
        {actions.length > 0 ? (
          <RowMenu handle={menu} label={t('session.menu')} actions={actions} onAction={act} />
        ) : null}
        {info.card}
      </div>
      {failure ? <div className="row-err">{failure}</div> : null}
      {grouping ? (
        <SectionDialog
          deviceId={deviceId}
          section={null}
          onCreated={(sectionId) => place({ sectionId })}
          onClose={() => setGrouping(false)}
        />
      ) : null}
      {spawning ? (
        <SpawnDialog
          deviceId={deviceId}
          parent={summary}
          onSpawned={(child) => onSelect({ deviceId, sessionId: child })}
          onClose={() => setSpawning(false)}
        />
      ) : null}
    </>
  )
})

/** 和定时任务有关的会话：标题后面一个小钟。是哪个任务、哪一次在会话顶上那一条里 */
function TaskMark({ kind }: { kind: 'run' | 'target' }) {
  const t = useT()
  const said = t(kind === 'run' ? 'tasks.mark.run' : 'tasks.mark.target')
  return (
    <span className="task-mark" role="img" data-task-mark={kind} title={said} aria-label={said}>
      <Icon name="clock" />
    </span>
  )
}

/**
 * 代理调 show 要给人看一个网页、用户当时没看着这个会话：标题后面一个小地球，打开这个会话就会显示那个网页
 * （side/browser/store.ts）。只订阅这一个会话有没有，别的会话的网页变了这一行不重画
 */
function BrowserWants({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useT()
  const wants = useBrowserWants(deviceId, sessionId)
  if (!wants) return null
  const said = t('browser.wants')
  return (
    <span className="web-mark" role="img" title={said} aria-label={said}>
      <Icon name="globe" />
    </span>
  )
}

interface GroupProps {
  deviceId: string
  selection: Selection | null
  /** 正在写的新会话。它所在的那一行（工作区或设备）标成选中 */
  draft: Draft | null
  onSelect(selection: Selection): void
  onCompose(draft: Draft): void
  /** 正在单独查看这台设备上的哪一组（置顶、某个组、某个工作区，键和 SessionGroups 的一样）。null：照常显示 */
  focus: string | null
  /** 单独查看一组；null 是回到照常显示 */
  onFocus(group: string | null): void
}

interface HeadProps {
  /** 组的键（和 SessionGroups 的一样）。外框上的 data-head 用它，自检按它找 */
  group: string
  deviceId: string
  /** 名字那一块：小箭头后面的东西 */
  label: ReactNode
  expanded: boolean
  onToggle(): void
  /** 名字后面的“单独查看”。正在单独查看时没有 */
  onFocus?: (() => void) | undefined
  /** 行尾的“新建会话” */
  add?: ReactNode
  /** 行尾的“更多” */
  menu?: ReactNode
  /** 信息卡：鼠标停在名字上浮出 */
  card?: ReturnType<typeof useHoverCard> | undefined
  /** 拖起这一行（工作区可以拖）。不给就不能拖 */
  onDrag?: ((event: DragEvent) => void) | undefined
  /** 是工作区那一行时是它的标识（外框上的 data-workspace，自检按它找） */
  workspaceId?: string
  /** 整行和名字按钮各加的样式名：工作区是 ws-line、ws-row，置顶和组是 sec-line、sec-row */
  className: string
  toggleClass: string
}

/**
 * 工作区、置顶、组的那一行：小箭头和名字是收起、展开的按钮，名字后面紧跟“单独查看”，
 * 收起时行尾汇总里面的状况。行上空白的地方点一下和点名字一样
 */
function HeadLine(props: HeadProps) {
  const { group, deviceId, label, expanded, onToggle, onFocus, add, menu, card, onDrag } = props
  const t = useT()
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: 空白处点一下和点名字一样，键盘走名字那个按钮
    <div
      className={`row-line head-line ${props.className}`}
      data-head={group}
      data-workspace={props.workspaceId}
      draggable={onDrag !== undefined}
      onDragStart={onDrag}
      onDragEnd={onDrag ? endDrag : undefined}
      onClick={(event) => {
        if (event.target === event.currentTarget || (event.target as Element).matches('.head-fill'))
          onToggle()
      }}
      {...card?.area}
    >
      <button
        type="button"
        className={`head-toggle ${props.toggleClass}`}
        aria-expanded={expanded}
        onClick={onToggle}
        {...card?.anchor}
      >
        <Caret />
        {label}
      </button>
      {onFocus ? (
        <button
          type="button"
          className="ibtn row-focus"
          title={t('sidebar.focus')}
          aria-label={t('sidebar.focus')}
          onClick={onFocus}
        >
          <Forward />
        </button>
      ) : null}
      <span className="grow head-fill" />
      {expanded ? null : (
        <span className="head-tally">
          <TallyMarks deviceId={deviceId} group={group} />
        </span>
      )}
      {add}
      {menu}
      {card?.card}
    </div>
  )
}

interface WorkspaceHeadProps {
  workspace: WorkspaceView
  device: DeviceView
  /** 里面有几个会话 */
  count: number
  expanded: boolean
  onToggle(): void
  onFocus?: (() => void) | undefined
  /** 行尾的“新建会话” */
  add: ReactNode
  /** 行尾的“更多”：改名与颜色、置顶、移到组、调顺序、删除。这台设备上整理不了就没有 */
  menu: ReactNode
}

/**
 * 工作区那一行：行上只有名字（挑过颜色的前面多一个色块），目录在信息卡里。
 * 收起的时候里面的会话都不画，行尾汇总一下里面有没有在等人的、在跑的、没看过的；展开着就不用，里面自己看得见。
 * 能整理的设备上可以拖：拖进置顶、组，或者拖到外面的工作区上排在它前面
 */
function WorkspaceHead(props: WorkspaceHeadProps) {
  const { workspace, device, count, expanded, onToggle, onFocus, add, menu } = props
  const card = useHoverCard(() => (
    <WorkspaceInfo workspace={workspace} device={device} count={count} />
  ))
  return (
    <HeadLine
      group={workspace.id}
      deviceId={device.id}
      className="ws-line"
      toggleClass="ws-row"
      workspaceId={workspace.id}
      label={
        <>
          {workspace.color ? <i className="ws-dot" style={wireStyle(workspace.color)} /> : null}
          <span className="name ell">{workspace.name}</span>
        </>
      }
      expanded={expanded}
      onToggle={onToggle}
      onFocus={onFocus}
      add={add}
      menu={menu}
      card={card}
      onDrag={
        device.organizable
          ? (event) =>
              beginDrag(event, {
                deviceId: device.id,
                kind: 'workspace',
                id: workspace.id,
                workspaceId: workspace.id,
                pinned: workspace.pinned,
                sectionId: workspace.sectionId,
              })
          : undefined
      }
    />
  )
}

/** 一个工作区里先露出几个会话 */
const FIRST_ROWS = 5
/** 单独查看一组时先露出几个 */
const FOCUS_ROWS = 50
/** 点一次“展示更多”多露出几个 */
const MORE_ROWS = 10
const NO_IDS: readonly string[] = []
const NO_CHILDREN: SessionChildren = {}
/** 侧栏里子会话最多套几层 */
const MAX_DEPTH = 8
/** 子会话每一层往里缩多少像素（和 tree.css 的 .tree-kids 一致） */
const INDENT = 14

/** 一组放东西的地方（置顶、组、外面的工作区、无项目）在拖放时的样子：能放的时候高亮 */
interface Zone {
  onDragOver(event: DragEvent): void
  onDragLeave(event: DragEvent): void
  onDrop(event: DragEvent): void
  'data-drop'?: 'on'
}

function DeviceGroup(props: GroupProps) {
  const { deviceId, selection, draft, onSelect, onCompose, focus, onFocus } = props
  const { channel } = useServices()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId)) ?? NO_WORKSPACES
  const groups = useKey<SessionGroups>(keys.groups(deviceId)) ?? {}
  const sections = useKey<SectionView[]>(keys.sections(deviceId)) ?? NO_SECTIONS
  /** 开着的工作区对话框：添加（workspace 为 null），或者改某一个 */
  const [dialog, setDialog] = useState<{ workspace: WorkspaceView | null } | null>(null)
  /** 开着的组对话框：新建（section 为 null，建好之后做 then），或者改名 */
  const [sectionDialog, setSectionDialog] = useState<{
    section: SectionView | null
    then?: (sectionId: string) => void
  } | null>(null)
  /** 收起了的：设备（''）、工作区、置顶、组，键和 SessionGroups 的一样 */
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  /** 各组点“展示更多”多露出来的个数。没点过的不在里面 */
  const [extra, setExtra] = useState<Readonly<Record<string, number>>>({})
  /** 收起了子会话的父会话 */
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  /** 拖着东西停在哪一组上（能放的时候才记） */
  const [over, setOver] = useState<string | null>(null)
  /** 开着“在手机上使用…”的出码对话框 */
  const [pairing, setPairing] = useState(false)
  /** 设备那一行的菜单：行尾的按钮和右键是同一份 */
  const deviceMenu = useRef<RowMenuHandle>(null)
  const dragging = useDragging()
  /** 父会话 → 挂在它下面的子会话（只有父会话也在侧栏里的才在） */
  const children = useKey<SessionChildren>(keys.children(deviceId)) ?? NO_CHILDREN
  const pressing = useKey<string[]>(keys.pressing(deviceId)) ?? NO_IDS
  /** 侧栏正只看哪几个 harness 的会话。空的：都看 */
  const filter = useSidebarHarnesses()
  const harnessOf = useKey<SessionHarnesses>(keys.harnessOf(deviceId))
  /** 别的应用派出来的会话（Claude 桌面端起的子会话）显不显示：默认不显示，开关在侧栏顶上的“更多”里 */
  const showNative = useSidebarNativeChildren()
  const nativeChildren = useKey<string[]>(keys.nativeChildren(deviceId)) ?? NO_IDS
  const reconnect = useReconnect(deviceId)
  const t = useT()
  const info = useHoverCard(() => (device ? <DeviceInfo device={device} /> : null))
  // 单独查看的那个组、工作区没了（别处删了）：回到照常显示
  const gone =
    focus !== null &&
    focus !== PINNED &&
    !sections.some((entry) => groupOfSection(entry.id) === focus) &&
    !workspaces.some((entry) => entry.id === focus)
  useEffect(() => {
    if (gone) onFocus(null)
  }, [gone, onFocus])
  // 拖完了：落点的高亮去掉
  useEffect(() => {
    if (!dragging) setOver(null)
  }, [dragging])
  if (!device) return null
  const picked = selection?.deviceId === deviceId ? selection.sessionId : null
  /** 非露出来不可的会话：正选中的那个，和停下来等人的那些。筛选筛不掉它们，“展示更多”也折不住它们 */
  const always = (id: string) => id === picked || pressing.includes(id)
  /** 不显示别的应用派出来的会话时，这些藏起来（非露出来不可的照样露） */
  const hidden = showNative ? NO_IDS : nativeChildren
  /** 一组里现在要画的会话：别的应用派出来的藏掉，只看某几个 harness 的时候再筛一遍 */
  const shown = (groupId: string) =>
    keepSessions(dropNativeChildren(groups[groupId], hidden, always), filter, harnessOf, always)

  /**
   * 挂到父会话下面去画的子会话：父会话这时也画在侧栏里（没被筛掉）的那些。
   * 父会话被筛掉了的，子会话照常排在自己那一组里
   */
  const listed = new Set(Object.keys(groups).flatMap((group) => shown(group)))
  const nested = new Set(
    Object.entries(children).flatMap(([parent, ids]) => (listed.has(parent) ? ids : [])),
  )
  const kidsOf = (id: string) =>
    keepSessions(dropNativeChildren(children[id], hidden, always), filter, harnessOf, always)
  const fold = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  /** 一行会话，和挂在它下面的子会话（一层套一层）。收起了的父会话下面只露出非露出来不可的 */
  const tree = (sessionId: string, depth: number): ReactNode => {
    // 父子关系由设备进程保证不成环；万一对面给错了，也不至于一直套下去
    if (depth > MAX_DEPTH) return null
    const kids = kidsOf(sessionId)
    const shut = folded.has(sessionId)
    const visible = shut ? kids.filter(always) : kids
    return (
      <div
        key={sessionId}
        className="tree-node"
        data-depth={depth}
        // 选中那一行连到设备竖线上的“分接线”要跨过缩进（tree.css）
        style={depth > 0 ? ({ '--indent': `${depth * INDENT}px` } as CSSProperties) : undefined}
      >
        <SessionRow
          deviceId={deviceId}
          sessionId={sessionId}
          selected={sessionId === picked}
          onSelect={onSelect}
          nested={depth > 0}
          kids={kids.length}
          folded={shut}
          onFold={() => fold(sessionId)}
        />
        {visible.length > 0 ? (
          <div className="tree-kids">{visible.map((id) => tree(id, depth + 1))}</div>
        ) : null}
      </div>
    )
  }

  const toggle = (id: string) =>
    setClosed((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  /**
   * 一组里的会话。多的时候只露出最近的几个，其余的收在“展示更多”后面，
   * 点一次多露出一批。折在后面的也有非露出来不可的（见上面的 always）。
   */
  const rows = (all: readonly string[], groupId: string, first = FIRST_ROWS) => {
    // 挂在父会话下面的不在组里单独占一行
    const list = all.filter((id) => !nested.has(id))
    const more = extra[groupId] ?? 0
    let limit = first + more
    // 只剩一个没露出来，不值得为它多一个按钮
    if (list.length - limit <= 1) limit = list.length
    const visible = list.filter((id, index) => index < limit || always(id))
    const hidden = list.length - visible.length
    const shrinkable = more > 0 && list.length > first + 1
    return (
      <>
        {visible.map((sessionId) => tree(sessionId, 0))}
        {hidden > 0 || shrinkable ? (
          <div className="ss-more">
            {hidden > 0 ? (
              <>
                <button
                  type="button"
                  className="mini more"
                  onClick={() => setExtra({ ...extra, [groupId]: more + MORE_ROWS })}
                >
                  {t('sidebar.showMore')}
                </button>
                <span className="dim grow">{t('sidebar.hiddenCount', { count: hidden })}</span>
              </>
            ) : (
              <span className="grow" />
            )}
            {shrinkable ? (
              <button
                type="button"
                className="mini less"
                onClick={() => setExtra(({ [groupId]: _gone, ...rest }) => rest)}
              >
                {t('sidebar.showLess')}
              </button>
            ) : null}
          </div>
        ) : null}
      </>
    )
  }
  // 没连着的时候，下面的会话是上次留下的，只能看
  const offline = device.connection !== 'online'
  const state: Record<DeviceView['connection'], [string, string] | null> = {
    online: null,
    connecting: ['pill wait', t('sidebar.connecting')],
    reconnecting: ['pill wait', t('sidebar.reconnecting')],
    offline: ['pill mute', t('sidebar.offline')],
    error: ['pill err', t('sidebar.failed')],
  }
  const pill = state[shownState(device)]
  /**
   * 有 harness 用不了、而下面还留着它的会话：行上只出一个记号，不放字。
   * 是哪个、为什么在信息卡里；它的会话那几行自己也看得出（变淡、徽标画成虚线）。
   * 都是用户自己停用的就画得淡一些：那不是出了状况
   */
  const stuck = offline
    ? []
    : device.harnesses.filter((entry) => device.stranded.includes(entry.id))
  const flag =
    stuck.length === 0
      ? null
      : stuck.some((entry) => entry.state === 'unavailable')
        ? 'dev-flag'
        : 'dev-flag mute'
  /** 对面不是设备服务、只有一个 harness 时，是哪一个 */
  const only = device.mode === 'single' ? device.harnesses[0] : undefined
  const open = !closed.has('')
  const composing = (workspaceId: string | null) =>
    draft?.deviceId === deviceId && draft.workspaceId === workspaceId
  /** 行尾的“新建会话”。设备没连上时建不了，不显示 */
  const add = (workspaceId: string | null) =>
    device.connection === 'online' ? (
      <button
        type="button"
        className={composing(workspaceId) ? 'ibtn row-add on' : 'ibtn row-add'}
        title={t(workspaceId === null ? 'newSession.buttonLoose' : 'newSession.button')}
        aria-label={t(workspaceId === null ? 'newSession.buttonLoose' : 'newSession.button')}
        onClick={() => onCompose({ deviceId, workspaceId })}
      >
        <Plus />
      </button>
    ) : null

  /** 整理侧栏的事没做成：出一条提示（行上没有地方说） */
  const organize = (done: Promise<unknown>) => {
    done.catch((error: unknown) =>
      showToast({
        id: 'organize-failed',
        tone: 'err',
        lifeMs: 8000,
        text: (say) => say('session.failed', { reason: reasonOf(error, say) }),
      }),
    )
  }
  /** 新建一个组，建好之后做 then（把会话、工作区放进去） */
  const newSection = (then?: (sectionId: string) => void) =>
    setSectionDialog(then ? { section: null, then } : { section: null })

  /**
   * 一处能放东西的地方。拖着的东西放得进来（drop.ts 说放下去有事可做）才接，接的时候高亮；
   * 放不进来的不拦，让外面一层（工作区在组里时是那个组）去接
   */
  const zone = (key: string, target: DropTarget): Zone => ({
    onDragOver(event) {
      const item = draggedItem()
      if (!item || !event.dataTransfer.types.includes(DRAG_TYPE)) return
      if (dropCommands(item, target, deviceId).length === 0) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      if (over !== key) setOver(key)
    },
    onDragLeave(event) {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      setOver((at) => (at === key ? null : at))
    },
    onDrop(event) {
      const item = draggedItem()
      if (!item) return
      const commands = dropCommands(item, target, deviceId)
      if (commands.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      setOver(null)
      endDrag()
      organize(
        (async () => {
          // 一样一样来：先从组里拿出来，再挪位置
          for (const { name, params } of commands) {
            await channel.command(name, { deviceId, ...params } as never)
          }
        })(),
      )
    },
    ...(over === key ? { 'data-drop': 'on' as const } : {}),
  })

  /** 和它在一处（同在置顶、同一个组、都在外面）的工作区，按设备上的顺序 */
  const siblingsOf = (workspace: WorkspaceView) =>
    workspaces.filter((entry) =>
      workspace.pinned
        ? entry.pinned
        : workspace.sectionId
          ? entry.sectionId === workspace.sectionId
          : !entry.pinned && !entry.sectionId,
    )
  /** 工作区行尾的“更多”。这台设备上整理不了（没连着、对面没有这组方法）就没有 */
  const workspaceMenu = (workspace: WorkspaceView) => {
    if (!device.organizable) return null
    const siblings = siblingsOf(workspace)
    const at = siblings.indexOf(workspace)
    const home = sections.find((entry) => entry.id === workspace.sectionId)
    const actions: RowAction[] = [{ id: 'edit', title: t('workspace.edit') }]
    if (home) actions.push({ id: 'ungroup', title: t('workspace.ungroup', { name: home.name }) })
    else
      actions.push({ id: 'pin', title: t(workspace.pinned ? 'workspace.unpin' : 'workspace.pin') })
    actions.push({
      id: 'group',
      title: t('section.move'),
      choices: {
        title: t('section.move.title'),
        back: t('session.move.back'),
        options: [
          ...sections
            .filter((entry) => entry.id !== workspace.sectionId)
            .map((entry) => ({ id: entry.id, title: entry.name })),
          { id: NEW_SECTION, title: t('section.add') },
        ],
      },
    })
    if (at > 0) actions.push({ id: 'up', title: t('workspace.up') })
    if (at < siblings.length - 1) actions.push({ id: 'down', title: t('workspace.down') })
    actions.push({
      id: 'delete',
      title: t('workspace.delete'),
      confirm: {
        title: t('workspace.delete.title', { name: workspace.name }),
        note: t('workspace.delete.note'),
        yes: t('workspace.delete'),
        no: t('workspace.cancel'),
      },
    })
    const target = { deviceId, workspaceId: workspace.id }
    const regroup = (sectionId: string) =>
      organize(channel.command('workspace.update', { ...target, sectionId }))
    return (
      <RowMenu
        label={t('workspace.menu')}
        actions={actions}
        onAction={(id, choice) => {
          if (id === 'edit') setDialog({ workspace })
          else if (id === 'delete') organize(channel.command('workspace.delete', target))
          else if (id === 'pin') {
            organize(channel.command('workspace.update', { ...target, pinned: !workspace.pinned }))
          } else if (id === 'ungroup') {
            organize(channel.command('workspace.update', { ...target, sectionId: null }))
          } else if (id === 'group') {
            if (choice === NEW_SECTION) newSection(regroup)
            else if (choice) regroup(choice)
          } else {
            // 上移：挪到同一处前一个的前面；下移：挪到同一处后面第二个的前面，
            // 后面只剩一个就挪到它在整张表里的下一个前面（没有就是最后）
            const next = siblings[at + 1]
            const before =
              id === 'up'
                ? (siblings[at - 1]?.id ?? null)
                : (siblings[at + 2]?.id ??
                  (next ? (workspaces[workspaces.indexOf(next) + 1]?.id ?? null) : null))
            organize(channel.command('workspace.move', { ...target, before }))
          }
        }}
      />
    )
  }

  /**
   * 只看某几个 harness 的时候，里面一个它们的会话都没有的工作区整块不出：留着一串空的工作区只是添乱。
   * 藏着别的应用派出来的会话时，里面只有这些会话的工作区也一样
   */
  const showsWorkspace = (workspace: WorkspaceView) => {
    if (filter.length > 0) return shown(workspace.id).length > 0
    // 里面只有藏起来的派出来的会话：同理整块不出。本来就空的工作区照常出
    return (groups[workspace.id]?.length ?? 0) === 0 || shown(workspace.id).length > 0
  }
  /**
   * 一个工作区：那一行和它下面的会话。outside：不在置顶、组里，是放东西的地方
   * （会话拖回自己的项目、别的工作区拖到它前面）
   */
  const workspaceBlock = (workspace: WorkspaceView, outside: boolean) => {
    const expanded = !closed.has(workspace.id)
    return (
      <div
        key={workspace.id}
        data-group={workspace.id}
        className="drop-zone"
        {...(outside ? zone(workspace.id, { kind: 'workspace', workspaceId: workspace.id }) : {})}
      >
        <WorkspaceHead
          workspace={workspace}
          device={device}
          count={dropNativeChildren(groups[workspace.id], hidden, always).length}
          expanded={expanded}
          onToggle={() => toggle(workspace.id)}
          onFocus={() => onFocus(workspace.id)}
          add={add(workspace.id)}
          menu={workspaceMenu(workspace)}
        />
        {expanded ? rows(shown(workspace.id), workspace.id) : null}
      </div>
    )
  }

  const pinnedWorkspaces = workspaces.filter((entry) => entry.pinned && showsWorkspace(entry))
  const sectionWorkspaces = (sectionId: string) =>
    workspaces.filter((entry) => entry.sectionId === sectionId && showsWorkspace(entry))
  const plainWorkspaces = workspaces.filter(
    (entry) => !entry.pinned && !entry.sectionId && showsWorkspace(entry),
  )
  /** 拖着这台设备上能整理的东西：这时候空的置顶也露出来当落点 */
  const draggingHere = dragging?.deviceId === deviceId

  /** 组的“更多”：改名、新建一个组、删除 */
  const sectionMenu = (section: SectionView) =>
    device.organizable ? (
      <RowMenu
        label={t('section.menu')}
        actions={[
          { id: 'rename', title: t('section.rename') },
          { id: 'add', title: t('section.add') },
          {
            id: 'delete',
            title: t('section.delete'),
            confirm: {
              title: t('section.delete.title', { name: section.name }),
              note: t('section.delete.note'),
              yes: t('section.delete'),
              no: t('workspace.cancel'),
            },
          },
        ]}
        onAction={(id) => {
          if (id === 'rename') setSectionDialog({ section })
          else if (id === 'add') newSection()
          else organize(channel.command('section.delete', { deviceId, sectionId: section.id }))
        }}
      />
    ) : null

  /** 置顶、组里的东西：会话在前，工作区在后。都没有时一句提示（也是放东西的地方） */
  const bandBody = (key: string, inside: WorkspaceView[], empty: string, first: number) => {
    const list = shown(key)
    if (list.length === 0 && inside.length === 0) return <div className="band-empty">{empty}</div>
    return (
      <>
        {rows(list, key, first)}
        {inside.map((workspace) => workspaceBlock(workspace, false))}
      </>
    )
  }

  /** 置顶或者一个组：那一行和里面的东西。整块都是放东西的地方 */
  const band = (
    key: string,
    target: DropTarget,
    title: ReactNode,
    inside: WorkspaceView[],
    empty: string,
    menu: ReactNode,
  ) => {
    const expanded = !closed.has(key)
    return (
      <div key={key} data-group={key} className="drop-zone band" {...zone(key, target)}>
        <HeadLine
          group={key}
          deviceId={deviceId}
          className="sec-line"
          toggleClass="sec-row"
          label={<span className="sec-label name ell">{title}</span>}
          expanded={expanded}
          onToggle={() => toggle(key)}
          onFocus={() => onFocus(key)}
          menu={menu}
        />
        {expanded ? bandBody(key, inside, empty, FIRST_ROWS) : null}
      </div>
    )
  }

  /** 照常显示：置顶、各个组排在工作区前面，是用户特意拿出来的；里面的东西不再出现在外面 */
  const everything = () => {
    const pinnedShown =
      shown(PINNED).length > 0 ||
      pinnedWorkspaces.length > 0 ||
      (draggingHere && filter.length === 0)
    const bands = sections.flatMap((entry) => {
      const key = groupOfSection(entry.id)
      const inside = sectionWorkspaces(entry.id)
      // 只看某几个 harness 的时候，里面没有它们的东西的组不出
      if (filter.length > 0 && shown(key).length === 0 && inside.length === 0) return []
      return [
        band(
          key,
          { kind: 'section', sectionId: entry.id },
          entry.name,
          inside,
          t('section.empty'),
          sectionMenu(entry),
        ),
      ]
    })
    return (
      <>
        {pinnedShown
          ? band(
              PINNED,
              { kind: 'pinned' },
              t('sidebar.pinned'),
              pinnedWorkspaces,
              t('sidebar.pinned.drop'),
              null,
            )
          : null}
        {bands}
        {plainWorkspaces.map((workspace) => workspaceBlock(workspace, true))}
        {shown(LOOSE).length > 0 ? (
          <div data-group={LOOSE} className="drop-zone" {...zone(LOOSE, { kind: 'loose' })}>
            <div className="sec-label">{t('workspace.none')}</div>
            {rows(shown(LOOSE), LOOSE)}
          </div>
        ) : null}
      </>
    )
  }

  /** 单独查看一组：只有它里面的东西，会话先露出多一些 */
  const focused = (key: string) => {
    if (key === PINNED) {
      return (
        <div data-group={PINNED} className="drop-zone band" {...zone(PINNED, { kind: 'pinned' })}>
          {bandBody(PINNED, pinnedWorkspaces, t('sidebar.pinned.drop'), FOCUS_ROWS)}
        </div>
      )
    }
    const section = sections.find((entry) => groupOfSection(entry.id) === key)
    if (section) {
      return (
        <div
          data-group={key}
          className="drop-zone band"
          {...zone(key, { kind: 'section', sectionId: section.id })}
        >
          {bandBody(key, sectionWorkspaces(section.id), t('section.empty'), FOCUS_ROWS)}
        </div>
      )
    }
    return (
      <div
        data-group={key}
        className="drop-zone"
        {...zone(key, { kind: 'workspace', workspaceId: key })}
      >
        {rows(shown(key), key, FOCUS_ROWS)}
      </div>
    )
  }
  /** 单独查看时顶上那一行写的名字 */
  const focusTitle = (key: string): string =>
    key === PINNED
      ? t('sidebar.pinned')
      : (sections.find((entry) => groupOfSection(entry.id) === key)?.name ??
        workspaces.find((entry) => entry.id === key)?.name ??
        '')

  const dialogs = (
    <>
      {dialog ? (
        <WorkspaceDialog
          deviceId={deviceId}
          workspace={dialog.workspace}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {sectionDialog ? (
        <SectionDialog
          deviceId={deviceId}
          section={sectionDialog.section}
          {...(sectionDialog.then ? { onCreated: sectionDialog.then } : {})}
          onClose={() => setSectionDialog(null)}
        />
      ) : null}
      {pairing ? <PairDialog device={device} onClose={() => setPairing(false)} /> : null}
    </>
  )
  /** 设备那一行的菜单：能整理的加项目、加组；支持扫码绑定、连着的“在手机上使用…” */
  const deviceActions: RowAction[] = [
    ...(device.organizable
      ? [
          { id: 'addWorkspace', title: t('workspace.add') },
          { id: 'addSection', title: t('section.add') },
        ]
      : []),
    ...(device.pairing && device.connection === 'online'
      ? [{ id: 'pair', title: t('pairing.use') }]
      : []),
  ]

  // 单独查看一组：顶上一行“返回”和它的名字，下面只有它里面的东西
  if (focus !== null && !gone) {
    return (
      <section
        className={offline ? 'dev-group focus off' : 'dev-group focus'}
        data-device={deviceId}
        data-focus={focus}
        style={wireStyle(device.wire)}
      >
        <div className="row-line focus-bar">
          <button type="button" className="focus-back" onClick={() => onFocus(null)}>
            <Back />
            <span>{t('sidebar.focus.back')}</span>
          </button>
          <span className="focus-title ell">{focusTitle(focus)}</span>
          <span className="focus-device dim ell">{t.text(device.name)}</span>
        </div>
        {dialogs}
        <div className="dev-body">{focused(focus)}</div>
      </section>
    )
  }

  return (
    <section
      className={offline ? 'dev-group off' : 'dev-group'}
      data-device={deviceId}
      style={wireStyle(device.wire)}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 右键出的菜单和行尾“更多”按钮是同一份，键盘走那个按钮 */}
      <div
        className="row-line"
        {...info.area}
        onContextMenu={(event) => {
          if (deviceActions.length === 0 || (event.target as Element).closest('.pick-pop')) return
          event.preventDefault()
          const box = event.currentTarget.getBoundingClientRect()
          const keyed = event.clientX === 0 && event.clientY === 0
          deviceMenu.current?.openAt(
            keyed ? box.left + 24 : event.clientX,
            keyed ? box.bottom : event.clientY,
          )
        }}
      >
        <button
          type="button"
          className="dev-row"
          aria-expanded={open}
          onClick={() => toggle('')}
          {...info.anchor}
        >
          <i className={offline ? 'wire-sq off' : 'wire-sq'} />
          {/* 行上只留名字；主机、连接方式这些在信息卡里 */}
          <span className="name ell">{t.text(device.name)}</span>
          {flag ? (
            <span className={flag} role="img" aria-label={t('sidebar.harnessDown')}>
              <Notice />
            </span>
          ) : null}
          <span className="grow" />
          {/* 整台设备收起来了：下面所有会话合起来的状况 */}
          {open ? null : <TallyMarks deviceId={deviceId} group={null} />}
          {pill ? <span className={pill[0]}>{pill[1]}</span> : null}
          {only && !offline ? (
            <span className="pill mute">{t('sidebar.single', { name: only.name })}</span>
          ) : null}
        </button>
        {add(null)}
        {deviceActions.length > 0 ? (
          <RowMenu
            handle={deviceMenu}
            label={t('sidebar.deviceMenu')}
            actions={deviceActions}
            onAction={(id) => {
              if (id === 'pair') setPairing(true)
              else if (id === 'addSection') newSection()
              else setDialog({ workspace: null })
            }}
          />
        ) : null}
        {info.card}
      </div>
      {dialogs}
      {open ? (
        <div className="dev-body">
          {device.failure ? (
            <div className="dev-note">
              <FailureNote failure={device.failure} target={device.target} onRetry={reconnect} />
            </div>
          ) : device.note ? (
            <div className="dev-note">{t.text(device.note)}</div>
          ) : null}
          {device.stale && offline && Object.keys(groups).length > 0 ? (
            <div className="dev-note">{t('sidebar.stale')}</div>
          ) : null}
          {/* 每一组的外框上写着它是哪一组（和数据副本里分组的键一样），自检按它找 */}
          {filter.length > 0 && Object.keys(groups).every((group) => shown(group).length === 0) ? (
            <div className="dev-none">{t('sidebar.filter.none')}</div>
          ) : null}
          {everything()}
        </div>
      ) : null}
    </section>
  )
}

/** 侧栏底部：核心的基本信息。同时确认命令这条路是通的 */
function CoreInfo() {
  const { channel } = useServices()
  const [info, setInfo] = useState<{ version: string; mock: boolean } | null>(null)
  const t = useT()
  useEffect(() => {
    const controller = new AbortController()
    channel
      .command('core.info', {}, { signal: controller.signal })
      .then(setInfo)
      .catch(() => {})
    return () => controller.abort()
  }, [channel])
  if (!info) return <span>{t('sidebar.connectingCore')}</span>
  return (
    <>
      {info.mock ? <span className="pill mute">{t('sidebar.mockCore')}</span> : null}
      <span className="mono">{t('sidebar.core', { version: info.version })}</span>
    </>
  )
}

/** 底下的“定时任务”：后面是各台设备上没看过的运行一共几条 */
function TasksLink({ on, onOpen }: { on: boolean; onOpen(): void }) {
  const unread = useKey<number>(keys.tasksUnread) ?? 0
  const t = useT()
  return (
    <button
      type="button"
      className={on ? 'sb-link tasks on' : 'sb-link tasks'}
      aria-current={on ? 'page' : undefined}
      onClick={onOpen}
    >
      <Clock />
      <span className="grow">{t('tasks.title')}</span>
      {unread > 0 ? (
        <span
          className="sb-count"
          data-unread={unread}
          title={t('tasks.unread', { count: unread })}
        >
          {unread}
        </span>
      ) : null}
    </button>
  )
}

interface SidebarProps {
  selection: Selection | null
  draft: Draft | null
  /** 正开着哪一页：已归档对话、设备、设置。都没开就是 null */
  page: Page | null
  onSelect(selection: Selection): void
  /** 到新建对话页去。给了去处就带着它（工作区行上的加号），null 是按默认的来（最上面的“新对话”） */
  onCompose(wish: PlaceWish | null): void
  onPage(page: Page): void
}

export function Sidebar(props: SidebarProps) {
  const { selection, draft, page, onSelect, onCompose, onPage } = props
  const deviceIds = useKey<string[]>(keys.devices) ?? []
  const t = useT()
  /** 正在单独查看哪台设备上的哪一组（置顶、组、工作区）。null：照常显示全部 */
  const [focus, setFocus] = useState<{ deviceId: string; group: string } | null>(null)
  const focusOn = useCallback(
    (deviceId: string) => (group: string | null) =>
      setFocus(group === null ? null : { deviceId, group }),
    [],
  )
  // 拖的东西放下了、松手了：落点的高亮收起来。被拖的那一行放下后可能已经换了地方（不在原处收不到 dragend），
  // 所以在窗口上也收一次；落在侧栏的落点上时，落点自己先处理完了才轮到这里
  useEffect(() => {
    window.addEventListener('dragend', endDrag)
    window.addEventListener('drop', endDrag)
    return () => {
      window.removeEventListener('dragend', endDrag)
      window.removeEventListener('drop', endDrag)
    }
  }, [])
  // 没开着哪一页、也没选中会话：主区域里就是新建对话页
  const composing = page === null && selection === null
  const shownIds = focus && deviceIds.includes(focus.deviceId) ? [focus.deviceId] : deviceIds
  return (
    <SidebarFrame label={t('sidebar.label')}>
      <div className="sb-top">
        <button
          type="button"
          className={composing ? 'sb-link new on' : 'sb-link new'}
          aria-current={composing ? 'page' : undefined}
          onClick={() => onCompose(null)}
        >
          <Plus />
          <span>{t('sidebar.newSession')}</span>
        </button>
        <HarnessFilter />
        <SidebarMore />
      </div>
      <div className="sb-scroll">
        {shownIds.map((deviceId) => (
          <DeviceGroup
            key={deviceId}
            deviceId={deviceId}
            selection={selection}
            draft={draft}
            onSelect={onSelect}
            onCompose={onCompose}
            focus={focus?.deviceId === deviceId ? focus.group : null}
            onFocus={focusOn(deviceId)}
          />
        ))}
      </div>
      <div className="sb-foot">
        <TasksLink on={page === 'tasks'} onOpen={() => onPage('tasks')} />
        <button
          type="button"
          className={page === 'devices' ? 'sb-link devices on' : 'sb-link devices'}
          aria-current={page === 'devices' ? 'page' : undefined}
          onClick={() => onPage('devices')}
        >
          <Machine />
          <span>{t('sidebar.devices')}</span>
        </button>
        <button
          type="button"
          className={page === 'archived' ? 'sb-link archived on' : 'sb-link archived'}
          aria-current={page === 'archived' ? 'page' : undefined}
          onClick={() => onPage('archived')}
        >
          <Archive />
          <span>{t('archived.title')}</span>
        </button>
        <button
          type="button"
          className={page === 'settings' ? 'sb-link settings on' : 'sb-link settings'}
          aria-current={page === 'settings' ? 'page' : undefined}
          onClick={() => onPage('settings')}
        >
          <Gear />
          <span>{t('sidebar.settings')}</span>
        </button>
        <div className="sb-core">
          <CoreInfo />
        </div>
      </div>
    </SidebarFrame>
  )
}
