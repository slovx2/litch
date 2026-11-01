import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import { currentPlatform } from '../app/platform.ts'
import { requestFind, requestSearch } from './actions.ts'

export function FindButton({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useT()
  const mac = currentPlatform() === 'mac'
  return (
    <button
      type="button"
      className="ibtn search-entry"
      title={`${t('search.inConversation')} (${mac ? '⌘F' : 'Ctrl+F'})`}
      aria-label={t('search.inConversation')}
      aria-keyshortcuts={mac ? 'Meta+F' : 'Control+F'}
      onClick={(event) => requestFind(deviceId, sessionId, event.currentTarget)}
    >
      <Icon name="findText" />
    </button>
  )
}

export function TitleSearchButton() {
  const t = useT()
  const mac = currentPlatform() === 'mac'
  return (
    <button
      type="button"
      className="ibtn search-sidebar"
      onClick={requestSearch}
      title={`${t('search.titles')} (${mac ? '⇧⌘F' : 'Ctrl+Shift+F'})`}
      aria-label={t('search.titles')}
      aria-keyshortcuts={mac ? 'Meta+Shift+F' : 'Control+Shift+F'}
    >
      <Icon name="search" />
    </button>
  )
}
