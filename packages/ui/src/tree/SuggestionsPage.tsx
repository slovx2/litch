import {
  type DeviceView,
  filterSuggestions,
  groupSuggestions,
  keys,
  type SuggestionEntry,
  type SuggestionView,
  type WorkspaceView,
} from '@litch/core'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { useNow } from '../app/clock.ts'
import { ago } from '../app/format.ts'
import { Close, Forward } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import { Brief, ProposalActs } from './ProposalCard.tsx'
import { SANDBOX_LEVEL } from './sandbox.ts'

const NONE: readonly SuggestionView[] = []

function SuggestionRow({
  row,
  onOpen,
}: {
  row: SuggestionView
  onOpen(selection: Selection, archived: boolean): void
}) {
  const t = useT()
  const now = useNow()
  const { deviceId, proposal, source } = row
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId)) ?? []
  const workspace = source.project ?? workspaces.find((entry) => entry.roots.includes(source.cwd))
  const online = device?.connection === 'online'
  return (
    <li className="tree-card prop-card suggestion-row" data-proposal={proposal.id}>
      <div className="prop-body">
        <b className="prop-title">{proposal.title}</b>
        <div className="prop-meta">
          <button
            type="button"
            className="btn ghost suggestion-source"
            data-act="open-source"
            disabled={!online}
            title={!online ? t('suggestions.offline') : t('suggestions.openSource')}
            onClick={() => onOpen({ deviceId, sessionId: source.threadId }, source.archived)}
          >
            <span className="ell">{source.title}</span>
            <Forward />
          </button>
          {source.archived ? <span className="pill mute">{t('suggestions.archived')}</span> : null}
          <span>{device ? t.text(device.name) : deviceId}</span>
          <span className="mono ell" title={source.cwd}>
            {workspace?.name ?? source.cwd}
          </span>
          <time
            dateTime={new Date(proposal.createdAt).toISOString()}
            title={new Date(proposal.createdAt).toLocaleString()}
          >
            {ago(proposal.createdAt, now, t)}
          </time>
        </div>
        <Brief prompt={proposal.prompt} background={proposal.background} />
        {proposal.widerSandbox ? (
          <p className="prop-wider">
            {t('proposal.wider', { level: t(SANDBOX_LEVEL[proposal.widerSandbox]) })}
          </p>
        ) : null}
        {!online ? <p className="dim">{t('suggestions.offline')}</p> : null}
        {source.archived ? <p className="dim">{t('suggestions.restore')}</p> : null}
        <ProposalActs
          deviceId={deviceId}
          sessionId={source.threadId}
          proposal={proposal}
          inbox
          sourceParent={{
            id: source.threadId,
            harness: source.harness,
            title: source.title,
            cwd: source.cwd,
            workspaceId: workspace?.id ?? null,
          }}
        />
      </div>
    </li>
  )
}

export function ManagerSuggestions({
  manager,
  onOpen,
}: {
  manager: ManagerView
  onOpen(selection: Selection, archived: boolean): void
}) {
  const all = useKey<readonly SuggestionView[]>(keys.suggestions) ?? NONE
  const rows = filterSuggestions(all, { deviceId: manager.deviceId, managerId: manager.id })
  const t = useT()
  return rows.length ? (
    <ul className="suggestions-list mg-suggestions-list">
      {rows.map((row) => (
        <SuggestionRow key={row.proposal.id} row={row} onOpen={onOpen} />
      ))}
    </ul>
  ) : (
    <p className="mg-empty">{t('suggestions.empty')}</p>
  )
}

function ManagerSuggestionCard({
  entry,
  onOpen,
}: {
  entry: Extract<SuggestionEntry, { kind: 'manager' }>
  onOpen(manager: ManagerView): void
}) {
  const manager = useKey<ManagerView>(keys.manager(entry.deviceId, entry.managerId))
  const device = useKey<DeviceView>(keys.device(entry.deviceId))
  const latest = entry.rows[0]
  const t = useT()
  return (
    <li
      className="suggestion-manager"
      data-suggestion-manager={entry.managerId}
      data-device={entry.deviceId}
    >
      <button
        type="button"
        disabled={!manager}
        onClick={() => manager && onOpen(manager)}
        title={!manager ? t('manager.unavailable') : t('suggestions.openManager')}
      >
        <header>
          <span className="pill mute">{t('manager.manager')}</span>
          <b>{manager?.name || t('manager.loading')}</b>
          <span className="pill mute">{entry.rows.length}</span>
          <Forward />
        </header>
        <span className="dim">{device ? t.text(device.name) : entry.deviceId}</span>
        <strong>{latest?.proposal.title}</strong>
        <p>{latest?.proposal.prompt}</p>
        <span className="suggestion-manager-open">{t('suggestions.openManager')}</span>
      </button>
    </li>
  )
}

export function SuggestionsPage({
  onManager,
  onOpen,
  onClose,
}: {
  onManager(manager: ManagerView): void
  onOpen(selection: Selection, archived: boolean): void
  onClose(): void
}) {
  const t = useT()
  const all = useKey<readonly SuggestionView[]>(keys.suggestions) ?? NONE
  const entries = groupSuggestions(all)
  return (
    <section className="arch-page" data-page="suggestions">
      <header className="arch-head">
        <h1>
          {t('suggestions.title')} <span className="pill mute">{all.length}</span>
        </h1>
        <button
          type="button"
          className="ibtn"
          aria-label={t('suggestions.close')}
          onClick={onClose}
        >
          <Close />
        </button>
      </header>
      <div className="arch-body">
        {entries.length ? (
          <ul className="suggestions-list">
            {entries.map((entry) =>
              entry.kind === 'manager' ? (
                <ManagerSuggestionCard
                  key={`manager:${entry.deviceId}:${entry.managerId}`}
                  entry={entry}
                  onOpen={onManager}
                />
              ) : (
                <SuggestionRow
                  key={`${entry.row.deviceId}:${entry.row.proposal.id}`}
                  row={entry.row}
                  onOpen={onOpen}
                />
              ),
            )}
          </ul>
        ) : (
          <p className="arch-note">{t('suggestions.empty')}</p>
        )}
      </div>
    </section>
  )
}
