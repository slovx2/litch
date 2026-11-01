import { useContext } from 'react'
import type { ManagerLink } from '../../../core/src/model-manager.mts'
import { requestOpenSession } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { ExternalLink } from '../transcript/ExternalLink.tsx'
import { RelationsContext } from './Relations.tsx'

export function BoardLinks({ links }: { links: ManagerLink[] }) {
  const context = useContext(RelationsContext)
  const t = useT()
  return (
    <ul className="mg-item-links">
      {links.length ? (
        links.map((link) => (
          <li key={`${link.kind}:${link.target}:${link.label}`}>
            {link.kind === 'thread' ? (
              <button
                type="button"
                className="btn ghost"
                disabled={!context}
                onClick={() =>
                  context &&
                  requestOpenSession({ deviceId: context.manager.deviceId, sessionId: link.target })
                }
              >
                {t('manager.source.line')} ·{' '}
                {context?.board.lines.find((line) => line.threadId === link.target)?.title ??
                  link.label ??
                  t('manager.source.line')}
              </button>
            ) : link.kind === 'url' ? (
              <ExternalLink href={link.target}>{link.label ?? link.target}</ExternalLink>
            ) : (
              <span title={link.target}>{link.label ?? link.target}</span>
            )}
          </li>
        ))
      ) : (
        <li>—</li>
      )}
    </ul>
  )
}
