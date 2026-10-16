// 侧面板里的“文件”标签：左边是文件树（上面带找文件的搜索框），右边是只读的文件查看器。
// 它挂在眼前会话所在的设备和工作区上；换会话就换一棵树，各棵树的状态（展开、选中、滚到哪、开着哪些文件）
// 在这次运行里一直留着，回来的时候还在。
import {
  baseName,
  type ChannelErrorShape,
  type DeviceView,
  type FileMatch,
  type FileTreeState,
  keys,
  normalizePath,
  relativeTo,
} from '@litch/core'
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import type { SideTabProps } from '../side/tabs.ts'
import { FILE_ACTIONS, type FileAction, type FileSubject, runFileAction } from './actions.ts'
import { ContextMenu } from './ContextMenu.tsx'
import { resultId, SearchResults, useFileSearch } from './FileSearch.tsx'
import { FileTree, type RowContext } from './FileTree.tsx'
import { FileViewer } from './FileViewer.tsx'
import {
  clampTreeWidth,
  openFile,
  pickRoot,
  revealPath,
  setTreeWidth,
  TREE_MIN,
  treeKey,
  usePickedRoot,
  useTreeWidth,
} from './state.ts'

interface Menu {
  subject: FileSubject
  x: number
  y: number
}

function Files({ deviceId, root }: { deviceId: string; root: string }) {
  const { replica, channel } = useServices()
  const t = useT()
  const uiKey = treeKey(deviceId, root)
  const device = useKey<DeviceView>(keys.device(deviceId))
  const state = useKey<FileTreeState>(keys.fileTree(deviceId, root))
  const showHidden = useKey<boolean>(keys.filesShowHidden) ?? false
  const treeWidth = useTreeWidth()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [menu, setMenu] = useState<Menu | null>(null)
  const search = useFileSearch(deviceId, root, query)
  // 结果换了一批：键盘从第一条走起。在画新结果的同一遍里就归零，不放到画完之后：
  // 放到之后的话，新结果刚出来那一帧里按的上下键会被后到的归零盖掉
  const [shownMatches, setShownMatches] = useState(search.matches)
  if (shownMatches !== search.matches) {
    setShownMatches(search.matches)
    setActive(0)
  }
  const searching = query.trim() !== ''
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  /** 菜单是从哪叫出来的：按 Esc 收起的时候焦点还给它 */
  const menuFrom = useRef<HTMLElement | null>(null)

  // 开始看这棵树：没取过根就去取，取过的重新对一遍
  useEffect(() => replica.files.open(deviceId, root), [replica, deviceId, root])

  // 给验收留的口子，界面自己不用：在这个元素上发一个 litch:files-check 事件，就把核心记的
  // “每个目录、每个文件各向设备问过几次”写到 data-check 上（量“每层只请求一次”）。
  // 事件的 detail 里带了 read 的话，再照那个路径读一次，把读到的种类或者被拒的原因也写上（量“根之外的路径被拒”）
  useEffect(() => {
    const element = box.current
    if (!element) return
    const report = async (event: Event) => {
      const read = (event as CustomEvent<{ read?: string } | null>).detail?.read
      const asked = await channel.command('files.requests', { deviceId })
      const outcome =
        read === undefined
          ? undefined
          : await channel.command('files.read', { deviceId, root, path: read }).then(
              (content) => ({ ok: true, kind: content.kind }),
              (error: ChannelErrorShape) => ({ ok: false, code: error.code, why: error.message }),
            )
      element.dataset.check = JSON.stringify({ ...asked, read: outcome })
    }
    const listener = (event: Event) => void report(event).catch(() => {})
    element.addEventListener('litch:files-check', listener)
    return () => element.removeEventListener('litch:files-check', listener)
  }, [channel, deviceId, root])

  const subjectOf = useCallback(
    (path: string, dir: boolean): FileSubject => ({ path, relative: relativeTo(root, path), dir }),
    [root],
  )
  const onContext = useCallback(
    ({ row, x, y }: RowContext) => {
      menuFrom.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      setMenu({ subject: subjectOf(row.path, row.kind === 'dir'), x, y })
    },
    [subjectOf],
  )
  const closeMenu = useCallback((refocus: boolean) => {
    setMenu(null)
    if (refocus) menuFrom.current?.focus({ preventScroll: true })
  }, [])

  /** 从结果里点了一条。目录：回到树上把它露出来；文件：打开，也在树里露出来 */
  const take = (match: FileMatch, pin: boolean) => {
    if (match.kind === 'dir') {
      revealPath(uiKey, match.path)
      setQuery('')
      return
    }
    openFile(uiKey, match.path, { pin, reveal: true })
  }

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      if (!query) return
      event.preventDefault()
      event.stopPropagation()
      setQuery('')
      return
    }
    const count = search.matches.length
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!searching) {
        // 没在找：往下就是进树里
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          box.current?.querySelector<HTMLElement>('[role="tree"]')?.focus()
        }
        return
      }
      if (count === 0) return
      event.preventDefault()
      const next = (active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
      setActive(next)
      document.getElementById(resultId(next))?.scrollIntoView({ block: 'nearest' })
      return
    }
    if (event.key === 'Enter') {
      const match = search.matches[active]
      if (!match) return
      event.preventDefault()
      take(match, true)
    }
  }

  // 拖树和内容之间那一条调树的宽度
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const grip = event.currentTarget
    const room = box.current?.clientWidth ?? 0
    const startX = event.clientX
    const startWidth = grip.parentElement?.offsetWidth ?? treeWidth
    grip.setPointerCapture(event.pointerId)
    const move = (moved: PointerEvent) =>
      setTreeWidth(clampTreeWidth(startWidth + (moved.clientX - startX), room))
    const stop = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', stop)
      grip.removeEventListener('pointercancel', stop)
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', stop)
    grip.addEventListener('pointercancel', stop)
    event.preventDefault()
  }

  const menuItems = useMemo(
    () => FILE_ACTIONS.map((id) => ({ id, title: t(`files.action.${id}`) })),
    [t],
  )
  const offline = device !== undefined && device.connection !== 'online'

  return (
    <div className="files" ref={box} data-root={root} data-device={deviceId}>
      <div className="ft" style={{ '--ft-w': `${treeWidth}px` } as CSSProperties}>
        <div className="ft-tools">
          <input
            ref={input}
            className="ft-search"
            type="text"
            role="combobox"
            aria-expanded={searching}
            aria-controls="ft-hits"
            aria-activedescendant={
              searching && search.matches[active] ? resultId(active) : undefined
            }
            aria-label={t('files.search')}
            placeholder={t('files.search')}
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKey}
          />
          <button
            type="button"
            className="ibtn"
            data-tool="hidden"
            title={t('files.hidden')}
            aria-label={t('files.hidden')}
            aria-pressed={showHidden}
            onClick={() => replica.files.setShowHidden(!showHidden)}
          >
            <Icon name="eye" small />
          </button>
          <button
            type="button"
            className="ibtn"
            data-tool="refresh"
            title={t('files.refresh')}
            aria-label={t('files.refresh')}
            aria-busy={state?.refreshing === true}
            disabled={offline}
            onClick={() => void replica.files.refresh(deviceId, root)}
          >
            <Icon name="reload" small />
          </button>
        </div>
        {searching ? (
          <SearchResults
            search={search}
            active={active}
            onPick={(match) => take(match, false)}
            onOpen={(match) => take(match, true)}
            onMenu={(match, event) => {
              event.preventDefault()
              menuFrom.current = input.current
              setMenu({
                subject: subjectOf(match.path, match.kind === 'dir'),
                x: event.clientX,
                y: event.clientY,
              })
            }}
          />
        ) : (
          <FileTree deviceId={deviceId} root={root} uiKey={uiKey} onContext={onContext} />
        )}
        {/* biome-ignore lint/a11y/useSemanticElements: 这是一条能拖、也能用方向键挪的分隔条，hr 做不了 */}
        <div
          className="ft-grip"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('files.tree.resize')}
          aria-valuenow={treeWidth}
          aria-valuemin={TREE_MIN}
          tabIndex={0}
          onPointerDown={drag}
          onKeyDown={(event) => {
            const step = { ArrowLeft: -16, ArrowRight: 16 }[event.key]
            if (!step) return
            event.preventDefault()
            setTreeWidth(clampTreeWidth(treeWidth + step, box.current?.clientWidth ?? 0))
          }}
        />
      </div>
      <FileViewer deviceId={deviceId} root={root} uiKey={uiKey} />
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.subject.relative || baseName(menu.subject.path)}
          items={menuItems}
          onPick={(id) => runFileAction(id as FileAction, menu.subject)}
          onClose={closeMenu}
        />
      ) : null}
    </div>
  )
}

export function FilesTab({ place }: SideTabProps) {
  const t = useT()
  const roots = useMemo(() => place.roots.map(normalizePath), [place.roots])
  const root = usePickedRoot(place.deviceId, place.workspaceId, roots)
  if (!root) return <div className="side-none dim">{t('files.noRoot')}</div>
  return (
    <>
      {roots.length > 1 ? (
        <div className="ft-roots">
          <span className="dim">{t('files.root')}</span>
          <select
            aria-label={t('files.root')}
            value={root}
            onChange={(event) => pickRoot(place.deviceId, place.workspaceId, event.target.value)}
          >
            {roots.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {/* 换一棵树就整个换掉：搜索框里的字、菜单这些不跟过去；各棵树自己的状态记在别处（state.ts），回来还在 */}
      <Files key={treeKey(place.deviceId, root)} deviceId={place.deviceId} root={root} />
    </>
  )
}
