import type { ManagerBoardView, ManagerItemView } from '../../../core/src/model-manager.mts'
import { requestOpenSession } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'

function Item({ item }: { item: ManagerItemView }) {
  const t = useT()
  return (
    <div className="mg-item">
      <span className="pill mute">{t(`manager.${item.status}`)}</span>
      <div className="grow">
        <b>{item.title}</b>
        {item.why ? <p>{item.why}</p> : null}
        {item.blockedBy.length ? <small>{item.blockedBy.join(' · ')}</small> : null}
        {item.unverified.map((text) => (
          <p key={text} className="dim">
            {t('manager.unverified')} · {text}
          </p>
        ))}
        {item.basis.length ? (
          <p className="mg-basis">
            {t('manager.basis')} {item.basis.map((link) => link.label ?? link.target).join(' · ')}
          </p>
        ) : null}
      </div>
      <small>{t(`manager.${item.owner.kind}`)}</small>
    </div>
  )
}

export function BoardPanels({
  board,
  tab,
  onTab,
}: {
  board: ManagerBoardView
  tab: 'overview' | 'items' | 'lines'
  onTab(tab: 'decisions' | 'items' | 'lines'): void
}) {
  const t = useT()
  if (tab === 'items')
    return (
      <div className="mg-stack">
        {(['blocked', 'running', 'review', 'backlog', 'deferred', 'done'] as const).map(
          (status) => {
            const items = board.items.filter((item) => item.status === status)
            return items.length ? (
              <details key={status} open={status !== 'done' && status !== 'deferred'}>
                <summary>
                  {t(`manager.${status}`)} {items.length}
                </summary>
                {items.map((item) => (
                  <Item key={item.id} item={item} />
                ))}
              </details>
            ) : null
          },
        )}
        {!board.items.length ? <p>{t('manager.none')}</p> : null}
      </div>
    )
  if (tab === 'lines')
    return (
      <div className="mg-stack">
        {board.lines.map((line) => (
          <article className="mg-card" key={line.threadId}>
            <header>
              <span className="pill mute">{t(`manager.${line.status}`)}</span>
              <b className="grow">{line.title}</b>
              <span className="chip">{line.harness}</span>
              <button
                type="button"
                className="btn ghost"
                onClick={() =>
                  requestOpenSession({ deviceId: board.deviceId, sessionId: line.threadId })
                }
              >
                {t('manager.openSession')}
              </button>
            </header>
            <p className="dim mono">
              {line.branch ?? t('manager.unknown')} ·{' '}
              {line.merged === null
                ? t('manager.unknown')
                : t(line.merged ? 'manager.merged' : 'manager.unmerged')}
              {line.ahead !== null ? ` · +${line.ahead}` : ''}
            </p>
            {line.report ? <p>{line.report.text}</p> : null}
            {line.unverified.map((text) => (
              <p className="mg-unverified" key={text}>
                {text}
              </p>
            ))}
          </article>
        ))}
        {!board.lines.length ? <p>{t('manager.none')}</p> : null}
      </div>
    )
  const blocked = board.items.filter((item) => item.status === 'blocked')
  const yours = board.items.filter(
    (item) => item.owner.kind === 'user' && item.status !== 'done' && item.status !== 'deferred',
  )
  return (
    <div className="mg-stack">
      <article className="mg-card">
        <header>
          <b className="grow">{t('manager.situation')}</b>
          <small className="dim">
            {board.situation ? new Date(board.situation.at).toLocaleString() : ''}
          </small>
        </header>
        <p>{board.situation?.text ?? t('manager.none')}</p>
      </article>
      <div className="mg-stats">
        <button type="button" onClick={() => onTab('decisions')}>
          <b>{board.decisions.filter((decision) => decision.status === 'open').length}</b>
          {t('manager.wait')}
        </button>
        <button type="button" onClick={() => onTab('items')}>
          <b>{yours.length}</b>
          {t('manager.yours')}
        </button>
        <button type="button" onClick={() => onTab('lines')}>
          <b>{board.lines.filter((line) => line.running).length}</b>
          {t('manager.running')}
        </button>
        <button type="button" onClick={() => onTab('items')}>
          <b>{board.items.filter((item) => item.status === 'done').length}</b>
          {t('manager.done')}
        </button>
      </div>
      <section>
        <h3>{t('manager.blocked')}</h3>
        {blocked.length ? (
          blocked.map((item) => <Item key={item.id} item={item} />)
        ) : (
          <p className="dim">{t('manager.none')}</p>
        )}
      </section>
      <section>
        <h3>{t('manager.yours')}</h3>
        {yours.length ? (
          yours.map((item) => <Item key={item.id} item={item} />)
        ) : (
          <p className="dim">{t('manager.none')}</p>
        )}
      </section>
      <section>
        <h3>{t('manager.activity')}</h3>
        {board.activities.map((activity) => (
          <div className="mg-activity" key={activity.id}>
            <time className="dim">{new Date(activity.at).toLocaleTimeString()}</time>
            <span>{activity.text}</span>
          </div>
        ))}
      </section>
    </div>
  )
}
