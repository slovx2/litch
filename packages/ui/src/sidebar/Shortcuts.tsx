// 侧栏最上面的快捷区：全局置顶，和本机分组。两处都不按设备分层，对话直接平铺，每行带设备的连线色块和设备名。
// 置顶资格在各台设备上，这里只合并显示、在本机排先后；本机分组只存在这台客户端上，可以混装任何设备的会话。
// 会话行和项目那一行的画法在 Sidebar.tsx（renderSession、renderWorkspace），这里管排布、收起、拖放和占位行。
import {
  type DeviceView,
  GROUPS_FOLD,
  keys,
  type LocalGroup,
  memberState,
  movePin,
  PINS_FOLD,
  type PinRef,
  pinKey,
  type SessionChildren,
  type SessionGroups,
  type SessionRef,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'
import {
  type CSSProperties,
  type DragEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { Page } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { wireStyle } from '../app/device.ts'
import { reasonOf } from '../app/errors.ts'
import { Caret, Plus } from '../app/icons.tsx'
import { useKey, useKeys, useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import {
  DRAG_TYPE,
  type DragItem,
  type DragOrigin,
  draggedItem,
  dropCommands,
  endDrag,
  onDragChange,
  startDrag,
} from './drop.ts'
import { LocalGroupDialog } from './LocalGroupDialog.tsx'
import { RowMenu } from './RowMenu.tsx'
import { revealRow } from './reveal.ts'
import { useSidebarReveal } from './reveal-context.ts'
import { organize, useCovers, useMergedPins, useOrganizer } from './shortcuts.ts'
import { toggleSidebarFold, useSidebarFolds } from './state.ts'
import { TallyView } from './TallyMarks.tsx'
import { tallySummaries } from './tally.ts'
import { MAX_DEPTH } from './tree.ts'

/** 快捷区里一项在本区的位置：菜单里的上移、下移用 */
export interface ShortcutPlace {
  kind: 'pin' | 'member'
  index: number
  count: number
  shift(step: -1 | 1): void
}

export interface ShortcutRowProps {
  deviceId: string
  sessionId: string
  /** 置顶区的行和设备树的行不会同时出现，算作 tree；本机组的行另算，免得和设备目录里那一行一起高亮 */
  source: 'tree' | 'local'
  nested: boolean
  kids: number
  folded: boolean
  onFold(): void
  place?: ShortcutPlace | undefined
  origin: DragOrigin
}

export interface ShortcutWorkspaceProps {
  deviceId: string
  workspaceId: string
  count: number
  expanded: boolean
  onToggle(): void
  place: ShortcutPlace
}

interface ShortcutsProps {
  renderSession(props: ShortcutRowProps): ReactNode
  renderWorkspace(props: ShortcutWorkspaceProps): ReactNode
  onPage(page: Page): void
}

/** 快捷区里子会话、项目收起的记录（和投影一样默认收起子会话） */
const SCOPE = ':shortcuts'
/** 每一层子会话往里缩多少（和 Sidebar.tsx 的 INDENT 一致） */
const INDENT = 20
const NO_CHILDREN: SessionChildren = {}
const NO_IDS: readonly string[] = []

const useDragging = (): DragItem | null => useSyncExternalStore(onDragChange, draggedItem)

/** 拖着的东西停在一项的下半截 */
const lowerHalf = (event: DragEvent): boolean => {
  const box = (event.currentTarget as Element).getBoundingClientRect()
  return event.clientY > box.top + box.height / 2
}

/** 拖着一项从 from 落到 target 的前面或后面：换算成“挪走之后的第几个” */
const dropIndex = (from: number, target: number, after: boolean): number => {
  const at = target + (after ? 1 : 0)
  return from >= 0 && from < at ? at - 1 : at
}

interface Over {
  zone: string
  mode: 'into' | 'before' | 'after'
}

export function Shortcuts(props: ShortcutsProps) {
  return (
    <>
      <PinsSection {...props} />
      <LocalGroupsSection {...props} />
    </>
  )
}

/** 一棵会话树：根会话和它下面的子会话（默认收起，点开才挂载后代） */
function SessionTree({
  deviceId,
  sessionId,
  depth,
  source,
  origin,
  place,
  render,
}: {
  deviceId: string
  sessionId: string
  depth: number
  source: 'tree' | 'local'
  origin: DragOrigin
  place?: ShortcutPlace | undefined
  render: ShortcutsProps['renderSession']
}): ReactNode {
  const children = useKey<SessionChildren>(keys.children(deviceId)) ?? NO_CHILDREN
  const folds = useSidebarFolds(SCOPE)
  if (depth > MAX_DEPTH) return null
  const kids = children[sessionId] ?? NO_IDS
  const id = `${deviceId}\n${sessionId}`
  const shut = !folds.folded.includes(id)
  const fold = () => toggleSidebarFold(SCOPE, 'folded', id)
  return (
    <div
      className="tree-node"
      data-depth={depth}
      data-device={deviceId}
      style={depth > 0 ? ({ '--indent': `${depth * INDENT}px` } as CSSProperties) : undefined}
    >
      {render({
        deviceId,
        sessionId,
        source,
        nested: depth > 0,
        kids: kids.length,
        folded: shut,
        onFold: fold,
        place,
        origin,
      })}
      {kids.length > 0 && !shut ? (
        <div className="tree-kids">
          {kids.map((kid) => (
            <SessionTree
              key={kid}
              deviceId={deviceId}
              sessionId={kid}
              depth={depth + 1}
              source={source}
              origin={origin}
              render={render}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 一节的标题行：小箭头和名字是收起、展开的按钮；收起时行尾汇总，行尾可放按钮 */
function SectionHead({
  name,
  label,
  closed,
  onToggle,
  tally,
  tools,
  drop,
}: {
  name: string
  label: string
  closed: boolean
  onToggle(): void
  tally?: ReactNode
  tools?: ReactNode
  drop?: boolean
}) {
  return (
    <div
      className="row-line projection-head sc-head"
      data-shortcut-head={name}
      data-drop={drop ? 'into' : undefined}
    >
      <button type="button" className="dev-row" aria-expanded={!closed} onClick={onToggle}>
        <span className={closed ? 'arr wire-sq shut' : 'arr wire-sq'}>
          <Caret />
        </span>
        <span className="name ell">{label}</span>
        <span className="grow" />
        {closed ? tally : null}
      </button>
      {tools}
    </div>
  )
}

/** 几个会话合起来的状况：收起的置顶区、本机组行尾用 */
function RefsTally({ refs }: { refs: readonly SessionRef[] }) {
  const summaries = useKeys<SessionSummary>(
    refs.map((ref) => keys.summary(ref.deviceId, ref.sessionId)),
  )
  return <TallyView tally={tallySummaries(summaries)} />
}

/** 拖着的这样东西能不能放进置顶区：来自能整理的设备、还没置顶的会话或项目 */
const pinnable = (item: DragItem | null): item is DragItem =>
  !!item &&
  (item.kind === 'session' || item.kind === 'workspace') &&
  item.origin?.kind !== 'pins' &&
  !item.pinned &&
  item.organizable === true

/**
 * 全局置顶：所有设备置顶的会话和项目在一个区里，按本机记着的先后排，可以跨设备交错。
 * 没有置顶时整节不出；拖着能置顶的东西时露出来当落点
 */
function PinsSection({ renderSession, renderWorkspace }: ShortcutsProps) {
  const { channel, replica } = useServices()
  const t = useT()
  const organizer = useOrganizer()
  const merged = useMergedPins()
  const covers = useCovers()
  const dragging = useDragging()
  const [over, setOver] = useState<Over | null>(null)
  const { request } = useSidebarReveal()
  const root = useRef<HTMLElement>(null)
  const revealed = useRef<unknown>(null)
  const closed = organizer?.folds[PINS_FOLD] === true
  const shown = merged.shown
  const coverRefs = [...covers].flatMap(([deviceId, ids]) =>
    [...ids].map((sessionId) => ({ deviceId, sessionId })),
  )
  const explicit = new Set(
    shown.flatMap((ref) => (ref.kind === 'session' ? [`${ref.deviceId}\n${ref.sessionId}`] : [])),
  )
  useEffect(() => {
    if (!dragging) setOver(null)
  }, [dragging])
  // 外面要定位的会话画在置顶区里：展开这一节，滚到那一行
  const wanted = request && covers.get(request.deviceId)?.has(request.sessionId) ? request : null
  useEffect(() => {
    if (!wanted || revealed.current === wanted) return
    if (closed) {
      void organize(channel, { type: 'fold', key: PINS_FOLD, closed: false })
      return
    }
    const element = root.current
    const scroll = element?.closest<HTMLElement>('.sb-scroll')
    const row = element?.querySelector<HTMLElement>(
      `[data-device="${CSS.escape(wanted.deviceId)}"] > .row-line[data-session="${CSS.escape(wanted.sessionId)}"]`,
    )
    if (!row || !scroll || !row.getClientRects().length) return
    revealRow(row, scroll)
    revealed.current = wanted
  })
  if (shown.length === 0 && !pinnable(dragging)) return null
  const shift = (ref: PinRef) => (step: -1 | 1) => {
    const index = shown.findIndex((entry) => pinKey(entry) === pinKey(ref))
    reorder(ref, index + step)
  }
  const reorder = (ref: PinRef, to: number) => {
    const order = movePin(merged, ref, to)
    if (!order || !organizer) return
    void organize(channel, { type: 'pins.order', order, base: organizer.revision })
  }
  /** 拖进来置顶：按来源设备发原来的置顶命令 */
  const pin = (item: DragItem) => {
    const workspaces = replica.store.get<WorkspaceView[]>(keys.workspaces(item.deviceId)) ?? []
    const commands = dropCommands(item, { kind: 'pinned' }, item.deviceId, workspaces)
    void (async () => {
      for (const { name, params } of commands)
        await channel.command(name, { deviceId: item.deviceId, ...params } as never)
    })().catch((error: unknown) =>
      showToast({
        id: 'organize-failed',
        tone: 'err',
        lifeMs: 8000,
        text: (say) => say('session.failed', { reason: reasonOf(error, say) }),
      }),
    )
  }
  const refOf = (item: DragItem): PinRef =>
    item.kind === 'workspace'
      ? { kind: 'workspace', deviceId: item.deviceId, workspaceId: item.id }
      : { kind: 'session', deviceId: item.deviceId, sessionId: item.id }
  /** 一项上的拖放：置顶区里拖着排先后（画线）；别处拖来的放进置顶区 */
  const itemZone = (ref: PinRef, index: number) => ({
    onDragOver(event: DragEvent) {
      const item = draggedItem()
      if (!item || !event.dataTransfer.types.includes(DRAG_TYPE)) return
      if (item.origin?.kind === 'pins') {
        event.preventDefault()
        event.stopPropagation()
        const mode = lowerHalf(event) ? 'after' : 'before'
        const zone = pinKey(ref)
        if (over?.zone !== zone || over.mode !== mode) setOver({ zone, mode })
      }
    },
    onDrop(event: DragEvent) {
      const item = draggedItem()
      if (item?.origin?.kind !== 'pins') return
      event.preventDefault()
      event.stopPropagation()
      const moving = refOf(item)
      const from = shown.findIndex((entry) => pinKey(entry) === pinKey(moving))
      reorder(moving, dropIndex(from, index, lowerHalf(event)))
      setOver(null)
      endDrag()
    },
  })
  const sectionZone = {
    onDragOver(event: DragEvent) {
      const item = draggedItem()
      if (!pinnable(item) || !event.dataTransfer.types.includes(DRAG_TYPE)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      if (over?.zone !== PINS_FOLD) setOver({ zone: PINS_FOLD, mode: 'into' })
    },
    onDragLeave(event: DragEvent) {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      setOver((was) => (was?.zone === PINS_FOLD ? null : was))
    },
    onDrop(event: DragEvent) {
      const item = draggedItem()
      if (!pinnable(item)) return
      event.preventDefault()
      setOver(null)
      endDrag()
      pin(item)
    },
  }
  return (
    <section
      ref={root}
      className="sc-group"
      data-shortcuts="pins"
      data-group=":pinned"
      {...sectionZone}
    >
      <SectionHead
        name="pins"
        label={t('sidebar.pinned')}
        closed={closed}
        onToggle={() => void organize(channel, { type: 'fold', key: PINS_FOLD, closed: !closed })}
        tally={<RefsTally refs={coverRefs} />}
        drop={over?.zone === PINS_FOLD}
      />
      {closed ? null : (
        <div className="sc-body">
          {shown.length === 0 ? (
            <div className="band-empty" data-drop="into">
              {t('sidebar.pinned.drop')}
            </div>
          ) : null}
          {shown.map((ref, index) => {
            const place: ShortcutPlace = {
              kind: 'pin',
              index,
              count: shown.length,
              shift: shift(ref),
            }
            const line = over?.zone === pinKey(ref) && over.mode !== 'into' ? over.mode : undefined
            return (
              <div key={pinKey(ref)} className="sc-item" data-drop={line} {...itemZone(ref, index)}>
                {ref.kind === 'session' ? (
                  <SessionTree
                    deviceId={ref.deviceId}
                    sessionId={ref.sessionId}
                    depth={0}
                    source="tree"
                    origin={{ kind: 'pins' }}
                    place={place}
                    render={renderSession}
                  />
                ) : (
                  <PinnedWorkspace
                    deviceId={ref.deviceId}
                    workspaceId={ref.workspaceId}
                    explicit={explicit}
                    place={place}
                    renderSession={renderSession}
                    renderWorkspace={renderWorkspace}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

/** 置顶的项目：那一行和里面（没进设备分组、没单独置顶的）会话。项目本身是项目，不是设备 */
function PinnedWorkspace({
  deviceId,
  workspaceId,
  explicit,
  place,
  renderSession,
  renderWorkspace,
}: {
  deviceId: string
  workspaceId: string
  explicit: ReadonlySet<string>
  place: ShortcutPlace
  renderSession: ShortcutsProps['renderSession']
  renderWorkspace: ShortcutsProps['renderWorkspace']
}) {
  const groups = useKey<SessionGroups>(keys.groups(deviceId))
  const children = useKey<SessionChildren>(keys.children(deviceId)) ?? NO_CHILDREN
  const folds = useSidebarFolds(SCOPE)
  const key = `${deviceId}\n${workspaceId}`
  const expanded = !folds.closed.includes(key)
  const ids = groups?.[workspaceId] ?? NO_IDS
  // 挂在别的会话下面的子会话跟着父会话画，不在项目里单独占一行
  const nested = new Set(
    ids.flatMap((id) => (children[id] ?? []).filter((kid) => ids.includes(kid))),
  )
  const top = ids.filter((id) => !nested.has(id) && !explicit.has(`${deviceId}\n${id}`))
  return (
    <div className="sc-ws" data-device={deviceId}>
      {renderWorkspace({
        deviceId,
        workspaceId,
        count: top.length,
        expanded,
        onToggle: () => toggleSidebarFold(SCOPE, 'closed', key),
        place,
      })}
      {expanded
        ? top.map((id) => (
            <SessionTree
              key={id}
              deviceId={deviceId}
              sessionId={id}
              depth={0}
              source="tree"
              origin={{ kind: 'pins' }}
              render={renderSession}
            />
          ))
        : null}
    </div>
  )
}

/**
 * 本机分组：只存在这台客户端上。没有组时整节不出（建组在会话菜单和侧栏“更多”里），拖着会话时露出来当落点。
 * 组里的会话照样留在设备目录里；置顶了的不在这里画，只数一下
 */
function LocalGroupsSection({ renderSession, onPage }: ShortcutsProps) {
  const { channel } = useServices()
  const t = useT()
  const organizer = useOrganizer()
  const dragging = useDragging()
  const [creating, setCreating] = useState<SessionRef[] | null>(null)
  const [over, setOver] = useState<Over | null>(null)
  useEffect(() => {
    if (!dragging) setOver(null)
  }, [dragging])
  if (!organizer) return null
  const groups = organizer.groups
  const blocked = organizer.status !== 'ok'
  const draggingSession = dragging?.kind === 'session'
  if (groups.length === 0 && !blocked && !draggingSession) return null
  const closed = organizer.folds[GROUPS_FOLD] === true
  const add = blocked ? null : (
    <button
      type="button"
      className="ibtn row-add"
      title={t('local.add')}
      aria-label={t('local.add')}
      onClick={() => setCreating([])}
    >
      <Plus />
    </button>
  )
  return (
    <section className="sc-group" data-shortcuts="groups">
      <SectionHead
        name="groups"
        label={t('local.title')}
        closed={closed}
        onToggle={() => void organize(channel, { type: 'fold', key: GROUPS_FOLD, closed: !closed })}
        tally={<RefsTally refs={groups.flatMap((group) => group.members)} />}
        tools={add}
      />
      {closed ? null : (
        <div className="sc-body">
          {blocked ? (
            <div className="dev-note">
              {t(organizer.status === 'newer' ? 'fault.organizerNewer' : 'fault.organizerBlocked')}
            </div>
          ) : null}
          {groups.map((group, index) => (
            <LocalGroupBlock
              key={group.id}
              group={group}
              index={index}
              count={groups.length}
              folded={organizer.folds[group.id] === true}
              over={over}
              setOver={setOver}
              renderSession={renderSession}
              onPage={onPage}
            />
          ))}
          {groups.length === 0 && draggingSession ? (
            // 还没有组：拖进来就新建一个组放进去
            // biome-ignore lint/a11y/noStaticElementInteractions: 拖放的落点；键盘走会话菜单里的“新建本机分组…”
            <div
              className="band-empty"
              data-drop={over?.zone === ':new' ? 'into' : undefined}
              onDragOver={(event) => {
                if (draggedItem()?.kind !== 'session') return
                event.preventDefault()
                if (over?.zone !== ':new') setOver({ zone: ':new', mode: 'into' })
              }}
              onDrop={(event) => {
                const item = draggedItem()
                if (item?.kind !== 'session') return
                event.preventDefault()
                endDrag()
                setCreating([{ deviceId: item.deviceId, sessionId: item.id }])
              }}
            >
              {t('local.dropNew')}
            </div>
          ) : null}
        </div>
      )}
      {creating ? (
        <LocalGroupDialog group={null} members={creating} onClose={() => setCreating(null)} />
      ) : null}
    </section>
  )
}

function LocalGroupBlock({
  group,
  index,
  count,
  folded,
  over,
  setOver,
  renderSession,
  onPage,
}: {
  group: LocalGroup
  index: number
  count: number
  folded: boolean
  over: Over | null
  setOver(over: Over | null): void
  renderSession: ShortcutsProps['renderSession']
  onPage(page: Page): void
}) {
  const { channel } = useServices()
  const t = useT()
  const covers = useCovers()
  const organizer = useOrganizer()
  const [renaming, setRenaming] = useState(false)
  const covered = (ref: SessionRef) => covers.get(ref.deviceId)?.has(ref.sessionId) === true
  const visible = group.members.filter((ref) => !covered(ref))
  const pinned = group.members.length - visible.length
  const zone = `group:${group.id}`
  const shiftGroup = (step: -1 | 1) =>
    void organize(channel, { type: 'group.move', groupId: group.id, to: index + step })
  const actions = [
    { id: 'rename', title: t('local.rename') },
    ...(index > 0 ? [{ id: 'up', title: t('section.up') }] : []),
    ...(index < count - 1 ? [{ id: 'down', title: t('section.down') }] : []),
    {
      id: 'delete',
      title: t('local.delete'),
      confirm: {
        title: t('local.delete.title', { name: group.name }),
        note: t('local.delete.note'),
        yes: t('local.delete'),
        no: t('workspace.cancel'),
      },
    },
  ]
  /** 落在组上：会话放进来（排到最后）；拖着别的组是插到这一组前面、后面 */
  const groupZone = {
    onDragOver(event: DragEvent) {
      const item = draggedItem()
      if (!item || !event.dataTransfer.types.includes(DRAG_TYPE)) return
      if (item.kind === 'localGroup') {
        if (item.id === group.id) return
        event.preventDefault()
        const mode = lowerHalf(event) ? 'after' : 'before'
        if (over?.zone !== zone || over.mode !== mode) setOver({ zone, mode })
        return
      }
      if (item.kind !== 'session') return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      if (over?.zone !== zone || over.mode !== 'into') setOver({ zone, mode: 'into' })
    },
    onDragLeave(event: DragEvent) {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      if (over?.zone === zone) setOver(null)
    },
    onDrop(event: DragEvent) {
      const item = draggedItem()
      if (!item) return
      if (item.kind === 'localGroup' && item.id !== group.id) {
        event.preventDefault()
        const from = organizer?.groups.findIndex((entry) => entry.id === item.id) ?? -1
        const to = dropIndex(from, index, lowerHalf(event))
        void organize(channel, { type: 'group.move', groupId: item.id, to })
      } else if (item.kind === 'session') {
        event.preventDefault()
        join(item)
      } else return
      setOver(null)
      endDrag()
    },
  }
  const join = (item: DragItem, to?: number) => {
    const member = { deviceId: item.deviceId, sessionId: item.id }
    const moving = item.origin?.kind === 'group' && item.origin.groupId === group.id
    void organize(
      channel,
      moving && to !== undefined
        ? { type: 'member.move', member, to }
        : { type: 'member.add', groupId: group.id, member, ...(to === undefined ? {} : { to }) },
    ).then((done) => {
      if (done && item.pinned)
        showToast({
          id: 'local-pinned',
          lifeMs: 5000,
          text: (say) => say('local.stillPinned', { name: group.name }),
        })
    })
  }
  /** 一个成员上的拖放：插到它前面、后面 */
  const memberZone = (ref: SessionRef, at: number) => ({
    onDragOver(event: DragEvent) {
      const item = draggedItem()
      if (item?.kind !== 'session' || !event.dataTransfer.types.includes(DRAG_TYPE)) return
      event.preventDefault()
      event.stopPropagation()
      const name = `member:${group.id}:${ref.deviceId}:${ref.sessionId}`
      const mode = lowerHalf(event) ? 'after' : 'before'
      if (over?.zone !== name || over.mode !== mode) setOver({ zone: name, mode })
    },
    onDrop(event: DragEvent) {
      const item = draggedItem()
      if (item?.kind !== 'session') return
      event.preventDefault()
      event.stopPropagation()
      const from = group.members.findIndex(
        (entry) => entry.deviceId === item.deviceId && entry.sessionId === item.id,
      )
      const sameGroup = item.origin?.kind === 'group' && item.origin.groupId === group.id
      join(item, dropIndex(sameGroup ? from : -1, at, lowerHalf(event)))
      setOver(null)
      endDrag()
    },
  })
  const line = over?.zone === zone && over.mode !== 'into' ? over.mode : undefined
  return (
    <div className="sc-local" data-local-group={group.id} data-drop={line} {...groupZone}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 拖组头排先后；键盘走组菜单里的上移、下移 */}
      <div
        className="row-line head-line sec-line"
        data-drop={over?.zone === zone && over.mode === 'into' ? 'into' : undefined}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_TYPE, group.id)
          event.dataTransfer.effectAllowed = 'move'
          startDrag({
            deviceId: '',
            kind: 'localGroup',
            id: group.id,
            workspaceId: null,
            pinned: false,
            sectionId: null,
          })
        }}
        onDragEnd={endDrag}
      >
        <button
          type="button"
          className="head-toggle sec-row"
          aria-expanded={!folded}
          onClick={() => void organize(channel, { type: 'fold', key: group.id, closed: !folded })}
        >
          <Caret />
          <span className="sec-label name ell">{group.name}</span>
        </button>
        <span className="grow head-fill" />
        {folded ? (
          <span className="head-tally">
            <RefsTally refs={visible} />
          </span>
        ) : null}
        <RowMenu
          label={t('local.menu')}
          actions={actions}
          onAction={(id) => {
            if (id === 'rename') setRenaming(true)
            else if (id === 'up' || id === 'down') shiftGroup(id === 'up' ? -1 : 1)
            else void organize(channel, { type: 'group.delete', groupId: group.id })
          }}
        />
      </div>
      {folded ? null : (
        <>
          {visible.map((ref) => {
            const at = group.members.indexOf(ref)
            const name = `member:${group.id}:${ref.deviceId}:${ref.sessionId}`
            const mark = over?.zone === name && over.mode !== 'into' ? over.mode : undefined
            const place: ShortcutPlace = {
              kind: 'member',
              index: visible.indexOf(ref),
              count: visible.length,
              shift: (step) => {
                const target = visible[visible.indexOf(ref) + step]
                if (!target) return
                void organize(channel, {
                  type: 'member.move',
                  member: ref,
                  to: group.members.indexOf(target),
                })
              },
            }
            return (
              <div
                key={`${ref.deviceId}\n${ref.sessionId}`}
                className="sc-item"
                data-drop={mark}
                {...memberZone(ref, at)}
              >
                <MemberEntry
                  member={ref}
                  group={group}
                  place={place}
                  renderSession={renderSession}
                  onPage={onPage}
                />
              </div>
            )
          })}
          {pinned > 0 ? (
            <div className="sc-note dim">{t('local.pinnedMore', { count: pinned })}</div>
          ) : null}
          {group.members.length === 0 ? <div className="band-empty">{t('local.empty')}</div> : null}
        </>
      )}
      {renaming ? <LocalGroupDialog group={group} onClose={() => setRenaming(false)} /> : null}
    </div>
  )
}

/** 本机组里的一个成员：能画的画成会话行，画不了的（未加载、已删除、设备没了、已归档）是一行占位，可以移出 */
function MemberEntry({
  member,
  group,
  place,
  renderSession,
  onPage,
}: {
  member: SessionRef
  group: LocalGroup
  place: ShortcutPlace
  renderSession: ShortcutsProps['renderSession']
  onPage(page: Page): void
}) {
  const { channel } = useServices()
  const t = useT()
  const device = useKey<DeviceView>(keys.device(member.deviceId))
  const summary = useKey<SessionSummary>(keys.summary(member.deviceId, member.sessionId))
  const archived = useKey<SessionSummary[] | null>(keys.archived(member.deviceId)) ?? null
  const state = memberState(member, {
    device,
    listed: summary !== undefined,
    covered: false,
    archived: archived?.map((entry) => entry.id) ?? null,
  })
  if (state === 'ok')
    return (
      <SessionTree
        deviceId={member.deviceId}
        sessionId={member.sessionId}
        depth={0}
        source="local"
        origin={{ kind: 'group', groupId: group.id }}
        place={place}
        render={renderSession}
      />
    )
  const title = archived?.find((entry) => entry.id === member.sessionId)?.title
  const said = t(`local.member.${state}` as 'local.member.unloaded')
  const name = device ? t.text(device.name) : member.deviceId
  const remove = () => void organize(channel, { type: 'member.remove', member })
  return (
    <div
      className="row-line sc-ghost"
      data-session={member.sessionId}
      data-device={member.deviceId}
      data-member-state={state}
      style={wireStyle(device?.wire)}
    >
      <button
        type="button"
        className="ss-row"
        disabled={state !== 'archived'}
        onClick={() => onPage('archived')}
      >
        <i className={device ? 'dev-tick off' : 'dev-tick none'} aria-hidden="true" />
        <span className="title ell grow">{title ? t.text(title) : said}</span>
        {title ? <span className="pill mute">{said}</span> : null}
        <span className="projection-device ell dim">{name}</span>
      </button>
      <RowMenu
        label={t('session.menu')}
        actions={[
          { id: 'leave', title: t('local.leave', { name: group.name }) },
          ...(place.index > 0 ? [{ id: 'up', title: t('section.up') }] : []),
          ...(place.index < place.count - 1 ? [{ id: 'down', title: t('section.down') }] : []),
        ]}
        onAction={(id) => {
          if (id === 'leave') remove()
          else place.shift(id === 'up' ? -1 : 1)
        }}
      />
    </div>
  )
}
