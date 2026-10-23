// 差异标签里的几块小东西：顶上那一条工具、文件头、没有内容可画时的说明、还原之前要说清楚的那句话。
import type { DiffEntry, DiffScope, DiffView, FileDiff } from '@litch/core'
import { DIFF_SCOPES } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import type { Translator } from '../i18n/index.ts'
import { Counts, entryTip, MARK } from './ChangedTree.tsx'
import { changedLines, FILE_LINES_MAX, type Totals } from './model.ts'
import type { DiffPrefs } from './state.ts'

export type FileAct = 'stage' | 'unstage' | 'discard'

export function Bar({
  view,
  scope,
  totals,
  prefs,
  narrow,
  busy,
  onScope,
  onPrefs,
  onRefresh,
}: {
  view: DiffView | undefined
  scope: DiffScope
  totals: Totals
  prefs: DiffPrefs
  /** 地方窄：只能合并着看 */
  narrow: boolean
  busy: boolean
  onScope(scope: DiffScope): void
  onPrefs(patch: Partial<DiffPrefs>): void
  onRefresh(): void
}) {
  const t = useT()
  const git = view?.source !== 'turn'
  const ready = view?.phase === 'ready'
  const split = prefs.layout === 'split' && !narrow
  return (
    <div className="db">
      {git ? (
        <div className="db-seg" role="radiogroup" aria-label={t('diffs.scope')}>
          {DIFF_SCOPES.map((item) => (
            // biome-ignore lint/a11y/useSemanticElements: 三选一的一排按钮，原生的单选框做不成这个样子
            <button
              key={item}
              type="button"
              role="radio"
              aria-checked={item === scope}
              data-scope={item}
              title={t(`diffs.scope.${item}.tip`)}
              onClick={() => onScope(item)}
            >
              {t(`diffs.scope.${item}`)}
            </button>
          ))}
        </div>
      ) : null}
      <span
        className="db-total"
        title={view?.branch ? t('diffs.branch', { name: view.branch }) : undefined}
      >
        {ready ? (
          <>
            {t('diffs.total', { files: totals.files })}
            <Counts entry={{ added: totals.added, removed: totals.removed, binary: false }} />
            {view?.since ? (
              <span className="db-since mono" title={t('diffs.since.tip')}>
                {t('diffs.since', { commit: view.since.slice(0, 7) })}
              </span>
            ) : null}
          </>
        ) : null}
      </span>
      <button
        type="button"
        className="ibtn"
        data-tool="layout"
        aria-pressed={split}
        disabled={narrow}
        title={
          narrow
            ? t('diffs.layout.narrow')
            : t(split ? 'diffs.layout.unified' : 'diffs.layout.split')
        }
        aria-label={t('diffs.layout.split')}
        onClick={() => onPrefs({ layout: split ? 'unified' : 'split' })}
      >
        <Icon name={split ? 'split' : 'unified'} />
      </button>
      <button
        type="button"
        className="ibtn"
        data-tool="wrap"
        aria-pressed={prefs.wrap || split}
        disabled={split}
        title={t(split ? 'diffs.wrap.split' : 'diffs.wrap')}
        aria-label={t('diffs.wrap')}
        onClick={() => onPrefs({ wrap: !prefs.wrap })}
      >
        <Icon name="wrap" />
      </button>
      <button
        type="button"
        className={busy ? 'ibtn spin' : 'ibtn'}
        data-tool="refresh"
        title={t(view && !view.watching && git ? 'diffs.refresh.unwatched' : 'diffs.refresh')}
        aria-label={t('diffs.refresh')}
        onClick={onRefresh}
      >
        <Icon name="reload" />
      </button>
    </div>
  )
}

/** 这个文件在这种范围下能做哪几件事 */
export function actsOf(entry: DiffEntry, scope: DiffScope, writable: boolean): FileAct[] {
  if (!writable || entry.status === 'conflicted') return []
  const acts: FileAct[] = []
  if (scope !== 'staged' && entry.unstaged) acts.push('stage')
  if (scope !== 'unstaged' && entry.staged) acts.push('unstage')
  // 只在提交里的改动（工作树会话对着起点看时）没有可还原的
  if (scope !== 'staged' && !entry.dir && (entry.staged || entry.unstaged)) acts.push('discard')
  return acts
}

const ACT_ICON = { stage: 'plus', unstage: 'minus', discard: 'undo' } as const

export function FileHead({
  file,
  entry,
  scope,
  writable,
  busy,
  onAct,
}: {
  file: FileDiff
  entry: DiffEntry | undefined
  scope: DiffScope
  writable: boolean
  busy: boolean
  onAct(act: FileAct, entry: DiffEntry): void
}) {
  const t = useT()
  const slash = file.path.lastIndexOf('/')
  return (
    <>
      {entry ? <span className={`dmark ${entry.status}`}>{MARK[entry.status]}</span> : null}
      <span className="dh-path" title={entry ? entryTip(entry, t, writable) : file.path}>
        <span className="dim">{file.path.slice(0, slash + 1)}</span>
        <span className="dh-name">{file.path.slice(slash + 1)}</span>
      </span>
      {entry?.mode ? (
        <span className="dh-mode">
          {entry.mode.from} → {entry.mode.to}
        </span>
      ) : null}
      {entry ? <Counts entry={entry} /> : null}
      <span className="dh-acts">
        {(entry ? actsOf(entry, scope, writable) : []).map((act) => (
          <button
            key={act}
            type="button"
            className="ibtn"
            data-act={act}
            disabled={busy}
            title={t(`diffs.${act}`)}
            aria-label={t(`diffs.${act}`)}
            onClick={() => entry && onAct(act, entry)}
          >
            <Icon name={ACT_ICON[act]} small />
          </button>
        ))}
      </span>
    </>
  )
}

/** 这个文件没有内容可画：说一句为什么 */
export function noteOf(file: FileDiff, entry: DiffEntry | undefined, t: Translator): string {
  if (file.kind === 'binary') return t('diffs.note.binary')
  if (file.kind === 'tooLarge') return t('diffs.note.tooLarge')
  if (file.kind === 'directory') return t('diffs.note.directory')
  if (file.kind === 'missing') return t('diffs.note.missing')
  if (entry?.status === 'renamed' || file.from) return t('diffs.note.renamed')
  if (entry?.mode) return t('diffs.note.mode')
  return t('diffs.note.empty')
}

/** 增删太多、不画内容的文件：只给摘要 */
export const hugeNote = (entry: DiffEntry, t: Translator): string =>
  t('diffs.note.huge', { n: changedLines(entry), max: FILE_LINES_MAX })

/** 还原之前的确认：标题、说明（会丢什么）、按钮上的字 */
export function discardAsk(
  entry: DiffEntry,
  scope: DiffScope,
  t: Translator,
): { title: string; note: string; yes: string } {
  const path = entry.path
  const added = entry.added ?? 0
  const removed = entry.removed ?? 0
  const lines = entry.binary ? t('diffs.lose.binary') : t('diffs.lose.lines', { added, removed })
  if (entry.status === 'untracked' || (entry.status === 'added' && scope === 'all')) {
    return {
      title: t('diffs.ask.delete', { path }),
      note: t(
        entry.status === 'untracked' ? 'diffs.ask.delete.untracked' : 'diffs.ask.delete.added',
        {
          lines: entry.binary
            ? t('diffs.lose.binaryFile')
            : t('diffs.lose.fileLines', { n: added }),
        },
      ),
      yes: t('diffs.delete'),
    }
  }
  if (scope === 'unstaged') {
    return {
      title: t('diffs.ask.discard', { path }),
      note: t(entry.staged ? 'diffs.ask.unstagedHalf' : 'diffs.ask.modified', { lines }),
      yes: t('diffs.discard'),
    }
  }
  if (entry.status === 'deleted') {
    return {
      title: t('diffs.ask.restore', { path }),
      note: t('diffs.ask.deleted'),
      yes: t('diffs.discard'),
    }
  }
  if (entry.status === 'renamed') {
    return {
      title: t('diffs.ask.discard', { path }),
      note: t('diffs.ask.renamed', { from: entry.from ?? '', lines }),
      yes: t('diffs.discard'),
    }
  }
  return {
    title: t('diffs.ask.discard', { path }),
    note: t('diffs.ask.modified', { lines }),
    yes: t('diffs.discard'),
  }
}
