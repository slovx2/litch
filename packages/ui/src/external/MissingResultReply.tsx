import type { ExternalMissingResultReply } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { ExtLink } from './parts.tsx'

export function MissingResultReply({ reply }: { reply: ExternalMissingResultReply }) {
  const t = useT()
  return (
    <span className="pill wait" data-missing-result-reply={reply.issueId}>
      <ExtLink url={reply.subject.url}>
        {reply.issueId} · {t('ext.missingResultReply')}
      </ExtLink>
    </span>
  )
}
