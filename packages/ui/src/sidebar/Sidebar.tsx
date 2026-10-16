import {
  type DeviceView,
  groupOfSection,
  keys,
  LOOSE,
  PINNED,
  pathTwin,
  type SectionView,
  type SessionGroups,
  type SessionHarnesses,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'
import { memo, type ReactNode, useEffect, useRef, useState } from 'react'
import type { Draft, Page, Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { useNow } from '../app/clock.ts'
import { badgeOf, downHarness, downText, nameOf, wireStyle } from '../app/device.ts'
import { reasonOf } from '../app/errors.ts'
import { ago } from '../app/format.ts'
import { useHoverCard } from '../app/HoverCard.tsx'
import { Archive, Caret, Gear, Icon, Machine, Notice, Plus } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import type { PlaceWish } from '../composer/new-place.ts'
import { FailureNote, shownState, useReconnect } from '../devices/status.tsx'
import { offerUndo } from './archive-undo.ts'
import { cwdMark } from './cwd.ts'
import { keepSessions } from './filter.ts'
import { HarnessFilter } from './HarnessFilter.tsx'
import { DeviceInfo, SessionInfo, WorkspaceInfo } from './InfoCards.tsx'
import { type RowAction, RowMenu, type RowMenuHandle } from './RowMenu.tsx'
import { SidebarFrame } from './SidebarFrame.tsx'
import { useSidebarHarnesses } from './state.ts'
import { TallyMarks } from './TallyMarks.tsx'
import { WorkspaceDialog } from './WorkspaceDialog.tsx'

const NO_WORKSPACES: readonly WorkspaceView[] = []

interface RowProps {
  deviceId: string
  sessionId: string
  selected: boolean
  onSelect(selection: Selection): void
}

/** 一行会话。只订阅这一个会话的摘要：别的会话变了，这一行不重画 */
const SessionRow = memo(function SessionRow({ deviceId, sessionId, selected, onSelect }: RowProps) {
  const { channel, replica } = useServices()
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId)) ?? NO_WORKSPACES
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
  /** 置顶，或者从置顶、从它所在的分区里拿出来 */
  const place = (to: 'pinned' | null) => {
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
    } else if (id === 'pin') place('pinned')
    else if (id === 'unpin' || id === 'unsection') place(null)
    else if (id === 'move') {
      if (choice) move(choice)
    } else run(id === 'archive' ? 'session.archive' : 'session.delete')
  }
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 右键出的菜单和行尾“更多”按钮是同一份，键盘走那个按钮 */}
      <div
        className="row-line"
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
          {apart ? (
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
          <span
            className={down ? 'chip off' : 'chip'}
            title={down ? downText(down, 'chip', t) : nameOf(device, summary.harness)}
          >
            {badgeOf(device, summary.harness)}
          </span>
          {summary.status === 'waiting' ? (
            <span className="pill wait">
              {t(summary.waitingFor === 'answer' ? 'sidebar.waitAnswer' : 'sidebar.waitApproval')}
            </span>
          ) : (
            <span className="time">{ago(summary.updatedAt, now, t)}</span>
          )}
        </button>
        {actions.length > 0 ? (
          <RowMenu handle={menu} label={t('session.menu')} actions={actions} onAction={act} />
        ) : null}
        {info.card}
      </div>
      {failure ? <div className="row-err">{failure}</div> : null}
    </>
  )
})

interface GroupProps {
  deviceId: string
  selection: Selection | null
  /** 正在写的新会话。它所在的那一行（工作区或设备）标成选中 */
  draft: Draft | null
  onSelect(selection: Selection): void
  onCompose(draft: Draft): void
}

interface WorkspaceHeadProps {
  workspace: WorkspaceView
  device: DeviceView
  /** 里面有几个会话 */
  count: number
  expanded: boolean
  onToggle(): void
  /** 行尾的“新建会话” */
  add: ReactNode
  /** 行尾的“更多”：改名与颜色、调顺序、删除。这台设备上整理不了就没有 */
  menu: ReactNode
}

/**
 * 工作区那一行：行上只有名字（挑过颜色的前面多一个色块），目录在信息卡里。
 * 收起的时候里面的会话都不画，行尾汇总一下里面有没有在等人的、在跑的、没看过的；展开着就不用，里面自己看得见
 */
function WorkspaceHead(props: WorkspaceHeadProps) {
  const { workspace, device, count, expanded, onToggle, add, menu } = props
  const info = useHoverCard(() => (
    <WorkspaceInfo workspace={workspace} device={device} count={count} />
  ))
  return (
    <div className="row-line" data-workspace={workspace.id} {...info.area}>
      <button
        type="button"
        className="ws-row"
        aria-expanded={expanded}
        onClick={onToggle}
        {...info.anchor}
      >
        <Caret />
        {workspace.color ? <i className="ws-dot" style={wireStyle(workspace.color)} /> : null}
        <span className="name ell grow">{workspace.name}</span>
        {expanded ? null : <TallyMarks deviceId={device.id} group={workspace.id} />}
      </button>
      {add}
      {menu}
      {info.card}
    </div>
  )
}

/** 一个工作区里先露出几个会话 */
const FIRST_ROWS = 5
/** 点一次“展示更多”多露出几个 */
const MORE_ROWS = 10
const NO_IDS: readonly string[] = []
const NO_SECTIONS: readonly SectionView[] = []

function DeviceGroup({ deviceId, selection, draft, onSelect, onCompose }: GroupProps) {
  const { channel } = useServices()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId)) ?? []
  const groups = useKey<SessionGroups>(keys.groups(deviceId)) ?? {}
  const sections = useKey<SectionView[]>(keys.sections(deviceId)) ?? NO_SECTIONS
  /** 开着的工作区对话框：添加（workspace 为 null），或者改某一个 */
  const [dialog, setDialog] = useState<{ workspace: WorkspaceView | null } | null>(null)
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  /** 各个工作区点“展示更多”多露出来的个数。没点过的不在里面 */
  const [extra, setExtra] = useState<Readonly<Record<string, number>>>({})
  const pressing = useKey<string[]>(keys.pressing(deviceId)) ?? NO_IDS
  /** 侧栏正只看哪几个 harness 的会话。空的：都看 */
  const filter = useSidebarHarnesses()
  const harnessOf = useKey<SessionHarnesses>(keys.harnessOf(deviceId))
  const reconnect = useReconnect(deviceId)
  const t = useT()
  const info = useHoverCard(() => (device ? <DeviceInfo device={device} /> : null))
  if (!device) return null
  const picked = selection?.deviceId === deviceId ? selection.sessionId : null
  /** 非露出来不可的会话：正选中的那个，和停下来等人的那些。筛选筛不掉它们，“展示更多”也折不住它们 */
  const always = (id: string) => id === picked || pressing.includes(id)
  /** 一组里现在要画的会话：只看某几个 harness 的时候是筛过的 */
  const shown = (groupId: string) => keepSessions(groups[groupId], filter, harnessOf, always)

  const toggle = (id: string) =>
    setClosed((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  /**
   * 一个工作区（或“无工作区”）里的会话。多的时候只露出最近的几个，其余的收在“展示更多”后面，
   * 点一次多露出一批。折在后面的也有非露出来不可的（见上面的 always）。
   */
  const rows = (list: readonly string[], groupId: string) => {
    const more = extra[groupId] ?? 0
    let limit = FIRST_ROWS + more
    // 只剩一个没露出来，不值得为它多一个按钮
    if (list.length - limit <= 1) limit = list.length
    const visible = list.filter((id, index) => index < limit || always(id))
    const hidden = list.length - visible.length
    const folded = more > 0 && list.length > FIRST_ROWS + 1
    return (
      <>
        {visible.map((sessionId) => (
          <SessionRow
            key={sessionId}
            deviceId={deviceId}
            sessionId={sessionId}
            selected={sessionId === picked}
            onSelect={onSelect}
          />
        ))}
        {hidden > 0 || folded ? (
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
            {folded ? (
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

  /** 整理工作区的事没做成：出一条提示（行上没有地方说） */
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
  /** 工作区行尾的“更多”。这台设备上整理不了（没连着、对面没有这组功能）就没有 */
  const workspaceMenu = (workspace: WorkspaceView, at: number) => {
    if (!device.organizable) return null
    const actions: RowAction[] = [{ id: 'edit', title: t('workspace.edit') }]
    if (at > 0) actions.push({ id: 'up', title: t('workspace.up') })
    if (at < workspaces.length - 1) actions.push({ id: 'down', title: t('workspace.down') })
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
    return (
      <RowMenu
        label={t('workspace.menu')}
        actions={actions}
        onAction={(id) => {
          if (id === 'edit') setDialog({ workspace })
          else if (id === 'delete') organize(channel.command('workspace.delete', target))
          else {
            // 上移：挪到前一个的前面；下移：挪到后面第二个的前面，后面只剩一个就是挪到最后
            const before = workspaces[id === 'up' ? at - 1 : at + 2]?.id ?? null
            organize(channel.command('workspace.move', { ...target, before }))
          }
        }}
      />
    )
  }

  return (
    <section
      className={offline ? 'dev-group off' : 'dev-group'}
      data-device={deviceId}
      style={wireStyle(device.wire)}
    >
      <div className="row-line" {...info.area}>
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
        {device.organizable ? (
          <RowMenu
            label={t('sidebar.deviceMenu')}
            actions={[{ id: 'addWorkspace', title: t('workspace.add') }]}
            onAction={() => setDialog({ workspace: null })}
          />
        ) : null}
        {info.card}
      </div>
      {dialog ? (
        <WorkspaceDialog
          deviceId={deviceId}
          workspace={dialog.workspace}
          onClose={() => setDialog(null)}
        />
      ) : null}
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
          {/* 置顶的和各个分区排在工作区前面：是用户特意拿出来的。里面的会话不再出现在工作区里。
              每一组的外框上写着它是哪一组（和数据副本里分组的键一样），自检按它找 */}
          {filter.length > 0 && Object.keys(groups).every((group) => shown(group).length === 0) ? (
            <div className="dev-none">{t('sidebar.filter.none')}</div>
          ) : null}
          {shown(PINNED).length > 0 ? (
            <div data-group={PINNED}>
              <div className="sec-label">{t('sidebar.pinned')}</div>
              {rows(shown(PINNED), PINNED)}
            </div>
          ) : null}
          {sections.map((entry) => {
            const group = groupOfSection(entry.id)
            const list = shown(group)
            return list.length > 0 ? (
              <div key={entry.id} data-group={group}>
                <div className="sec-label">{entry.name}</div>
                {rows(list, group)}
              </div>
            ) : null
          })}
          {workspaces.map((workspace, at) => {
            const list = shown(workspace.id)
            // 只看某几个 harness 的时候，里面一个它们的会话都没有的工作区整行不出：留着一串空的工作区只是添乱
            if (filter.length > 0 && list.length === 0) return null
            const expanded = !closed.has(workspace.id)
            return (
              <div key={workspace.id} data-group={workspace.id}>
                <WorkspaceHead
                  workspace={workspace}
                  device={device}
                  count={groups[workspace.id]?.length ?? 0}
                  expanded={expanded}
                  onToggle={() => toggle(workspace.id)}
                  add={add(workspace.id)}
                  menu={workspaceMenu(workspace, at)}
                />
                {expanded ? rows(list, workspace.id) : null}
              </div>
            )
          })}
          {shown(LOOSE).length > 0 ? (
            <div data-group={LOOSE}>
              <div className="sec-label">{t('workspace.none')}</div>
              {rows(shown(LOOSE), LOOSE)}
            </div>
          ) : null}
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
  // 没开着哪一页、也没选中会话：主区域里就是新建对话页
  const composing = page === null && selection === null
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
      </div>
      <div className="sb-scroll">
        {deviceIds.map((deviceId) => (
          <DeviceGroup
            key={deviceId}
            deviceId={deviceId}
            selection={selection}
            draft={draft}
            onSelect={onSelect}
            onCompose={onCompose}
          />
        ))}
      </div>
      <div className="sb-foot">
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
