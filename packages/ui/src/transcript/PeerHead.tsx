// 别的会话发来的消息（Claude 的本机收件箱：别的 Claude 会话用 SendMessage 发进来，peerMessages 扩展）：
// 照 Claude 桌面端，画在用户消息的位置、标明是谁发来的，不当成用户自己的话。这是气泡最上面那一行：
// 谁发的、对方是不是跳过确认的会话；发送方是 Claude 桌面端的会话时能点回去
import type { PeerView } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'

// Claude 桌面端会话的深链（桌面端自己给会话的 link 就是这个形状）
const DESKTOP_SESSION = /^local_[A-Za-z0-9-]+$/

export function desktopSessionLink(session: string | null): string | null {
  return session && DESKTOP_SESSION.test(session) ? `claude://claude.ai/epitaxy/${session}` : null
}

export function PeerHead({ peer }: { peer: PeerView }) {
  const t = useT()
  const link = desktopSessionLink(peer.session)
  const shell = typeof window === 'undefined' ? undefined : window.litchShell
  return (
    <div className="peer-head">
      <Icon name="note" small />
      <span className="peer-from">
        {peer.name ? t('peer.from', { name: peer.name }) : t('peer.fromUnnamed')}
      </span>
      {peer.bypass ? (
        <span className="peer-tag" title={t('peer.bypassHint')}>
          {t('peer.bypass')}
        </span>
      ) : null}
      {link && shell ? (
        <button
          type="button"
          className="peer-open"
          title={t('peer.openHint')}
          onClick={() => shell.openExternal(link)}
        >
          {t('peer.open')}
        </button>
      ) : null}
    </div>
  )
}
