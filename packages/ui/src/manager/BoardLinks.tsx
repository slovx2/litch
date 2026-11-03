import { useContext } from 'react'
import type { ManagerLink } from '../../../core/src/model-manager.mts'
import { useT } from '../app/appearance.ts'
import { RelationLink } from './RelationLink.tsx'
import { RelationsContext } from './Relations.tsx'

export function BoardLinks({ links }: { links: ManagerLink[] }) {
  const context = useContext(RelationsContext)
  const t = useT()
  return (
    <ul className="mg-item-links">
      {links.map((link) => (
        <li key={`${link.kind}:${link.target}`}>
          {context ? (
            <RelationLink
              target={{
                kind: link.kind,
                target: link.target,
                ...(link.label ? { label: link.label } : {}),
              }}
              manager={context.manager}
            />
          ) : (
            <span role="alert">
              {t('manager.linkUnavailable')} · {link.label ?? link.target}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}
