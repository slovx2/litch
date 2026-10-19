// 侧面板里的“差异”标签：左边（地方窄的时候在上面）是变了的文件，右边是差异。
// 数据是设备上那个工作目录的 git 状态（核心的 diff 主题和 diff.* 命令）；面板没显示的时候不订阅，核心也就不去取。
// 文件多或者改动多的时候一次只看一个文件；一个文件改得太多就只给摘要（阈值在 model.ts）。
import {
  type ChannelErrorShape,
  type DeviceView,
  type DiffEntry,
  type DiffScope,
  type DiffView,
  type FileDiff,
  isAbsolutePath,
  keys,
  normalizePath,
  pathTwin,
  relativeTo,
} from '@litch/core'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { Icon } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import type { Translator } from '../i18n/index.ts'
import type { SideTabProps } from '../side/tabs.ts'
import { addNote, notesKey, removeNote, useNotes } from './annotations.ts'
import { ChangedTree } from './ChangedTree.tsx'
import { useDiffFiles } from './data.ts'
import {
  cellOf,
  linesIn,
  planOf,
  rangesOf,
  reveal,
  SPLIT_MIN_WIDTH,
  TREE_WIDTH,
  tooBig,
  totalsOf,
} from './model.ts'
import { NoteCard, NoteEditor } from './Notes.tsx'
import { type Expanded, Pane } from './Pane.tsx'
import { stopPaint } from './paint.ts'
import { Bar, discardAsk, type FileAct, FileHead, hugeNote, noteOf } from './parts.tsx'
import type { PickLine, RowExtra, Selected } from './Rows.tsx'
import {
  placeKey,
  setDiffPrefs,
  setPlaceState,
  toggleDir,
  useDiffPrefs,
  usePlaceState,
  useWanted,
} from './state.ts'

const NO_ENTRIES: readonly DiffEntry[] = []
/** 整个标签窄于这么多像素：顶上那一条里的合计（几个文件、增删多少行）不显示，地方留给范围和按钮 */
const TIGHT_WIDTH = 400

function sayError(error: ChannelErrorShape, t: Translator): string {
  if (error.text) return t.text(error.text)
  if (error.code === 'timeout') return t('error.timeout')
  if (error.code === 'offline') return t('error.offline')
  return error.message || t('error.other')
}

/** 一个不画内容的文件的样子：只有摘要 */
const stub = (entry: DiffEntry, kind: FileDiff['kind']): FileDiff => ({
  path: entry.path,
  from: entry.from,
  kind,
  hunks: [],
  full: false,
  language: null,
  noEolOld: false,
  noEolNew: false,
  added: entry.added ?? 0,
  removed: entry.removed ?? 0,
})

function Diffs({
  deviceId,
  root,
  sessionId,
  shown,
}: {
  deviceId: string
  root: string
  sessionId: string | null
  shown: boolean
}) {
  const { replica, channel } = useServices()
  const t = useT()
  const key = placeKey(deviceId, root)
  const place = usePlaceState(key)
  const prefs = useDiffPrefs()
  const { scope } = place
  const device = useKey<DeviceView>(keys.device(deviceId))
  const view = useKey<DiffView>(keys.diff(deviceId, root, scope, sessionId))
  const refused = useKey<ChannelErrorShape>(keys.diffError(deviceId, root, scope, sessionId))
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [jump, setJump] = useState<{ path: string; nonce: number } | null>(null)
  const [expanded, setExpanded] = useState<ReadonlyMap<string, Expanded>>(new Map())
  const [ask, setAsk] = useState<DiffEntry | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // 面板显示着才订阅：没人看的时候核心不去设备上取
  useEffect(
    () => (shown ? replica.openDiff(deviceId, root, scope, sessionId) : undefined),
    [replica, deviceId, root, scope, sessionId, shown],
  )
  useEffect(() => (shown ? undefined : stopPaint()), [shown])
  useEffect(() => stopPaint, [])

  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const measure = () => setWidth(element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const ready = view?.phase === 'ready'
  const entries = ready ? view.entries : NO_ENTRIES
  const git = view?.source !== 'turn'
  const byPath = useMemo(() => new Map(entries.map((entry) => [entry.path, entry])), [entries])
  const totals = useMemo(() => totalsOf(entries), [entries])
  const planned = useMemo(() => planOf(entries, view?.omitted ?? 0), [entries, view?.omitted])
  const picked = place.picked !== null && byPath.has(place.picked) ? place.picked : null
  const current = picked ?? entries[0]?.path ?? null
  const currentEntry = current === null ? undefined : byPath.get(current)
  const together = planned === 'together'
  // 一次看一个文件时，改得太多的那个不取内容
  const skip = !together && currentEntry !== undefined && tooBig(currentEntry)
  const loaded = useDiffFiles(
    { deviceId, root, scope, sessionId },
    view?.version ?? 0,
    together ? null : current,
    together,
    shown && ready && entries.length > 0 && !skip,
  )
  // 对面说太多了不一次全给：这一版按一个一个看
  const single = !together || loaded.truncated
  const fallback = useDiffFiles(
    { deviceId, root, scope, sessionId },
    view?.version ?? 0,
    current,
    false,
    shown && ready && together && loaded.truncated && currentEntry !== undefined,
  )
  const source = together && loaded.truncated ? fallback : loaded

  const files = useMemo<readonly FileDiff[]>(() => {
    if (skip && currentEntry) return [stub(currentEntry, 'tooLarge')]
    const got = source.files ?? []
    // 接成一长条时，改得太多的文件也只给摘要
    return got.map((file) => {
      const entry = byPath.get(file.path)
      return entry && tooBig(entry) && file.kind === 'text' ? stub(entry, 'tooLarge') : file
    })
  }, [source.files, skip, currentEntry, byPath])

  // 别处要在差异里看某个文件：找到它，选中、滚过去。给的可能是完整路径，
  // 还可能是根的另一种写法（macOS 上 Claude Code 给 /private/var/…，根是 /var/…）
  const os = device?.os
  const wanted = useWanted()
  const taken = useRef(0)
  const retried = useRef(0)
  const [retryDone, setRetryDone] = useState(0)
  const stillLoading = view?.refreshing === true
  useEffect(() => {
    if (!wanted || taken.current === wanted.nonce || !ready) return
    const full = normalizePath(wanted.path)
    const path = isAbsolutePath(full) ? relativeTo(root, full, pathTwin(os)) : full
    if (!byPath.has(path)) {
      // 这种范围下没有它：回到“全部”再找一次
      if (scope !== 'all') {
        setPlaceState(key, { scope: 'all' })
        return
      }
      // 手上的概况可能是旧的（回合还没结束，面板还没跟上代理刚改的）：重新取一遍再找
      if (retried.current !== wanted.nonce) {
        retried.current = wanted.nonce
        channel
          .command('diff.refresh', { deviceId, root })
          .catch(() => {})
          .finally(() => setRetryDone((count) => count + 1))
        return
      }
      if (stillLoading || retryDone === 0) return
      // 还是没有：它现在没有没提交的改动了（提交了，或者改回去了），说一声
      taken.current = wanted.nonce
      showToast({ id: 'diff-wanted', lifeMs: 5000, text: (say) => say('diffs.wanted.none') })
      return
    }
    taken.current = wanted.nonce
    setPlaceState(key, { picked: path, query: '' })
    setJump({ path, nonce: wanted.nonce })
  }, [wanted, ready, byPath, root, os, scope, key, stillLoading, retryDone, channel, deviceId])

  const pick = useCallback(
    (path: string) => {
      setPlaceState(key, { picked: path })
      setJump((before) => ({ path, nonce: (before?.nonce ?? 0) + 1 }))
    },
    [key],
  )
  const onCurrent = useCallback((path: string) => setPlaceState(key, { picked: path }), [key])

  const where = useRef({ deviceId, root, scope, sessionId })
  where.current = { deviceId, root, scope, sessionId }
  const shownFiles = useRef(files)
  shownFiles.current = files
  const opened = useRef(expanded)
  opened.current = expanded
  const onReveal = useCallback(
    (path: string, gap: number) => {
      const base = shownFiles.current.find((file) => file.path === path)
      if (!base) return
      const total = (file: FileDiff) => file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
      const open = opened.current.get(path)
      if (open && open.base === base) {
        const ranges = reveal(open.ranges, gap, total(open.full))
        setExpanded((before) => new Map(before).set(path, { ...open, ranges }))
        return
      }
      // 第一次展开：取带着整个文件的那一份
      channel.command('diff.file', { ...where.current, path, full: true }).then(
        (full) => {
          if (full.kind !== 'text') return
          const ranges = reveal(rangesOf(base, full), gap, total(full))
          setExpanded((before) => new Map(before).set(path, { base, full, ranges }))
        },
        (error: ChannelErrorShape) => {
          if (error.code === 'cancelled') return
          showToast({
            id: 'diff-expand',
            tone: 'err',
            lifeMs: 6000,
            text: (say) => say('diffs.failed', { reason: sayError(error, say) }),
          })
        },
      )
    },
    [channel],
  )

  // ---------- 行内批注：按会话攒着，发下一条消息时带上（annotations.ts） ----------
  const noteKey = sessionId === null ? null : notesKey(deviceId, sessionId)
  const notes = useNotes(noteKey ?? '')
  const [selected, setSelected] = useState<(Selected & { path: string }) | null>(null)
  // 换了会话：正要写的那一条是给上一个会话的，不带过来
  // biome-ignore lint/correctness/useExhaustiveDependencies: 就是要在会话变了的时候清
  useEffect(() => setSelected(null), [sessionId])
  const onPick = useCallback((path: string, ...[side, cell, extend]: Parameters<PickLine>) => {
    setSelected((before) => {
      const same = before && before.path === path && before.side === side
      if (same && extend) {
        return { ...before, from: Math.min(before.from, cell.no), to: Math.max(before.to, cell.no) }
      }
      // 再点一下选中的那一行：不选了
      if (same && before.from === cell.no && before.to === cell.no) return null
      return { path, side, from: cell.no, to: cell.no }
    })
  }, [])
  const extraFor = useMemo(() => {
    if (noteKey === null) return null
    const made = new Map<string, RowExtra | null>()
    return (path: string): RowExtra | null => {
      const known = made.get(path)
      if (known !== undefined) return known
      const mine = notes.filter((note) => note.path === path)
      const picking = selected?.path === path ? selected : null
      const extra: RowExtra | null =
        mine.length === 0 && !picking
          ? null
          : (row) => {
              const cards = mine.filter((note) => cellOf(row, note.side)?.no === note.to)
              const editing = picking !== null && cellOf(row, picking.side)?.no === picking.to
              if (cards.length === 0 && !editing) return null
              return (
                <div className="dnotes">
                  {cards.map((note) => (
                    <NoteCard
                      key={note.id}
                      note={note}
                      onRemove={() => removeNote(noteKey, note.id)}
                    />
                  ))}
                  {editing ? (
                    <NoteEditor
                      label={
                        picking.from === picking.to
                          ? t('diffs.note.line', { from: picking.from })
                          : t('diffs.note.lines', { from: picking.from, to: picking.to })
                      }
                      onCancel={() => setSelected(null)}
                      onSave={(text) => {
                        const file = shownFiles.current.find((item) => item.path === path)
                        const open = opened.current.get(path)
                        const source = open && open.base === file ? open.full : file
                        const lines = source
                          ? linesIn(source, picking.side, picking.from, picking.to)
                          : []
                        addNote(noteKey, { ...picking, text }, lines)
                        setSelected(null)
                      }}
                    />
                  ) : null}
                </div>
              )
            }
      made.set(path, extra)
      return extra
    }
  }, [noteKey, notes, selected, t])

  const run = async (act: FileAct, entry: DiffEntry) => {
    setBusy(entry.path)
    const base = { deviceId, root }
    try {
      if (act === 'stage') await channel.command('diff.stage', { ...base, paths: [entry.path] })
      else if (act === 'unstage') {
        await channel.command('diff.unstage', { ...base, paths: [entry.path] })
      } else {
        await channel.command('diff.discard', {
          ...base,
          scope,
          path: entry.path,
          expect: entry.status,
        })
      }
    } catch (error) {
      showToast({
        id: 'diff-act',
        tone: 'err',
        lifeMs: 8000,
        text: (say) =>
          say('diffs.act.failed', { reason: sayError(error as ChannelErrorShape, say) }),
      })
    } finally {
      setBusy(null)
    }
  }
  const onAct = (act: FileAct, entry: DiffEntry) => {
    // 暂存和取消暂存不丢东西，直接做；还原先问
    if (act === 'discard') setAsk(entry)
    else void run(act, entry)
  }

  const refresh = () => {
    setRefreshing(true)
    channel
      .command('diff.refresh', { deviceId, root })
      .catch(() => {})
      .finally(() => setRefreshing(false))
  }

  // 给验收留的口子，界面自己不用：在这个元素上发一个 litch:diff-check 事件，
  // 就把核心记的“为差异向设备起过几条命令、重新取过几次”写到 data-check 上
  useEffect(() => {
    const element = box.current
    if (!element) return
    const listener = () => {
      channel.command('diff.requests', { deviceId }).then(
        (asked) => {
          element.dataset.check = JSON.stringify(asked)
        },
        () => {},
      )
    }
    element.addEventListener('litch:diff-check', listener)
    return () => element.removeEventListener('litch:diff-check', listener)
  }, [channel, deviceId])

  const omitted = view?.omitted ?? 0
  const writable = view?.writable === true
  // 文件那一栏放左边之后，剩下的地方还够并排，才放左边；不够就挪到上面，把宽度都给差异
  const stacked = width > 0 && width < TREE_WIDTH + SPLIT_MIN_WIDTH
  const narrow = (stacked ? width : width - TREE_WIDTH) < SPLIT_MIN_WIDTH
  const split = prefs.layout === 'split' && !narrow
  const index = current === null ? -1 : entries.findIndex((entry) => entry.path === current)
  const step = (by: number) => {
    const next = entries[index + by]
    if (next) pick(next.path)
  }

  let body: ReactNode = null
  if (refused) body = <div className="dz">{sayError(refused, t)}</div>
  else if (device && device.connection !== 'online' && !ready) {
    body = <div className="dz">{t('diffs.offline')}</div>
  } else if (!view || view.phase === 'loading')
    body = <div className="dz">{t('diffs.loading')}</div>
  else if (view.phase === 'failed') {
    body = (
      <div className="dz" data-state="failed">
        <span>{t('diffs.failed', { reason: view.error ? sayError(view.error, t) : '' })}</span>
        <button type="button" className="btn ghost" data-act="retry" onClick={refresh}>
          {t('diffs.retry')}
        </button>
      </div>
    )
  } else if (view.phase === 'absent') {
    const why =
      view.why === 'notRepo' && view.source === 'turn'
        ? 'diffs.notRepo.turn'
        : `diffs.${view.why ?? 'notRepo'}`
    body = (
      <div className="dz" data-why={view.why ?? ''}>
        {t(why as 'diffs.notRepo')}
      </div>
    )
  } else if (entries.length === 0) {
    body = (
      <div className="dz" data-state="clean">
        {t(git ? `diffs.clean.${scope}` : 'diffs.notRepo.turn')}
      </div>
    )
  }

  return (
    <div
      className="diffs"
      ref={box}
      data-root={root}
      data-device={deviceId}
      data-phase={view?.phase ?? 'none'}
      data-source={view?.source ?? ''}
      data-version={view?.version ?? 0}
      data-entries={entries.length}
      data-mode={single ? 'single' : 'together'}
      data-stack={stacked ? 'on' : 'off'}
      // 窄到顶上那一条放不下合计了
      data-tight={width > 0 && width < TIGHT_WIDTH ? 'on' : 'off'}
      // 改得太多、不取内容的那个文件没有什么要等的
      data-load={skip ? 'ready' : source.state}
    >
      <Bar
        view={view}
        scope={scope}
        totals={totals}
        prefs={prefs}
        narrow={narrow}
        busy={refreshing || view?.refreshing === true}
        onScope={(next: DiffScope) => setPlaceState(key, { scope: next })}
        onPrefs={setDiffPrefs}
        onRefresh={refresh}
      />
      {ready && !git ? <div className="dnote">{t('diffs.turnSource')}</div> : null}
      {body ?? (
        <div className="dmain">
          <ChangedTree
            entries={entries}
            query={place.query}
            closed={place.closed}
            picked={current}
            git={git}
            onQuery={(query) => setPlaceState(key, { query })}
            onPick={pick}
            onToggle={(path) => toggleDir(key, path)}
          />
          <div className="dside">
            {single ? (
              <div className="dstep">
                <span className="dim">{t('diffs.single')}</span>
                <span className="dstep-at">
                  {t('diffs.position', { at: index + 1, total: entries.length })}
                </span>
                <button
                  type="button"
                  className="ibtn"
                  data-act="prev"
                  disabled={index <= 0}
                  title={t('diffs.prev')}
                  aria-label={t('diffs.prev')}
                  onClick={() => step(-1)}
                >
                  <Icon name="up" small />
                </button>
                <button
                  type="button"
                  className="ibtn"
                  data-act="next"
                  disabled={index < 0 || index >= entries.length - 1}
                  title={t('diffs.next')}
                  aria-label={t('diffs.next')}
                  onClick={() => step(1)}
                >
                  <Icon name="down" small />
                </button>
              </div>
            ) : null}
            {omitted > 0 ? <div className="dnote">{t('diffs.omitted', { n: omitted })}</div> : null}
            {files.length === 0 ? (
              <div className="dz" data-state={source.state}>
                {source.state === 'failed' && source.error
                  ? t('diffs.failed', { reason: sayError(source.error, t) })
                  : t('diffs.note.loading')}
              </div>
            ) : (
              <Pane
                key={single ? (current ?? '') : '*'}
                files={files}
                entries={byPath}
                split={split}
                // 并排时总是折行：两栏各占一半，不折的话右边那栏要横着滚才看得到
                wrap={prefs.wrap || split}
                expanded={expanded}
                jump={single ? null : jump}
                onCurrent={single ? noop : onCurrent}
                onReveal={git ? onReveal : null}
                onPick={noteKey === null ? null : onPick}
                selected={selected}
                extraFor={extraFor}
                renderHead={(file, entry) => (
                  <FileHead
                    file={file}
                    entry={entry}
                    scope={scope}
                    writable={writable}
                    busy={busy === file.path}
                    onAct={onAct}
                  />
                )}
                renderNote={(file, entry) =>
                  entry && tooBig(entry) ? hugeNote(entry, t) : noteOf(file, entry, t)
                }
              />
            )}
          </div>
        </div>
      )}
      {ask ? (
        <Confirm
          {...discardAsk(ask, scope, t)}
          no={t('diffs.cancel')}
          onYes={() => {
            const entry = ask
            setAsk(null)
            void run('discard', entry)
          }}
          onClose={() => setAsk(null)}
        />
      ) : null}
    </div>
  )
}

const noop = () => {}

export function DiffTab({ place, shown }: SideTabProps) {
  const t = useT()
  // 看的是眼前会话的工作目录（代理的改动落在那里）；还没有会话就看工作区的第一个根
  const root = place.cwd ?? place.roots[0] ?? null
  if (!root) return <div className="side-none dim">{t('diffs.noRoot')}</div>
  return (
    <Diffs
      key={placeKey(place.deviceId, root)}
      deviceId={place.deviceId}
      root={root}
      sessionId={place.sessionId}
      shown={shown}
    />
  )
}
