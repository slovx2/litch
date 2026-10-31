import {
  type DeviceView,
  filterSuggestions,
  keys,
  type SuggestionView,
  type WorkspaceView,
} from '@litch/core'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { useNow } from '../app/clock.ts'
import { ago } from '../app/format.ts'
import { Close, Forward } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import { Brief, ProposalActs } from './ProposalCard.tsx'
import { SANDBOX_LEVEL } from './sandbox.ts'

export type SuggestionFilter = { deviceId: string; managerId: string } | null
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

export function SuggestionsPage({
  filter,
  onClear,
  onOpen,
  onClose,
}: {
  filter: SuggestionFilter
  onClear(): void
  onOpen(selection: Selection, archived: boolean): void
  onClose(): void
}) {
  const t = useT()
  const all = useKey<readonly SuggestionView[]>(keys.suggestions) ?? NONE
  const rows = filterSuggestions(all, filter)
  return (
    <section className="arch-page" data-page="suggestions">
      <header className="arch-head">
        <h1>
          {t('suggestions.title')} <span className="pill mute">{rows.length}</span>
        </h1>
        {filter ? (
          <button type="button" className="btn" onClick={onClear}>
            {t('suggestions.all')}
          </button>
        ) : null}
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
        {filter ? <p className="dim">{t('suggestions.manager')}</p> : null}
        {rows.length ? (
          <ul className="suggestions-list">
            {rows.map((row) => (
              <SuggestionRow key={`${row.deviceId}:${row.proposal.id}`} row={row} onOpen={onOpen} />
            ))}
          </ul>
        ) : (
          <p className="arch-note">{t('suggestions.empty')}</p>
        )}
      </div>
    </section>
  )
}
