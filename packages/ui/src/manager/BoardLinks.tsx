import type { ManagerLink } from '../../../core/src/model-manager.mts'
import { ExternalLink } from '../transcript/ExternalLink.tsx'

export function BoardLinks({ links }: { links: ManagerLink[] }) {
  return (
    <ul className="mg-item-links">
      {links.length ? (
        links.map((link) => (
          <li key={`${link.kind}:${link.target}:${link.label}`}>
            {link.kind === 'url' ? (
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
