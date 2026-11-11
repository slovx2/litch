import * as Clipboard from 'expo-clipboard'
import { useState } from 'react'
import { Alert, Linking } from 'react-native'
import {
  EnrichedMarkdownText,
  type EnrichedMarkdownTextProps,
} from 'react-native-enriched-markdown'
import { useT } from './i18n'
import { Sheet } from './kit/overlays'
import { performWebLinkAction, webLinkActions } from './web-links'

/** 对话、卡片和经理正文共用的网页长按菜单。 */
export function useWebLinkMenu() {
  const t = useT()
  const [url, setUrl] = useState<string | null>(null)
  return {
    open(value: string): boolean {
      if (!webLinkActions(value).length) return false
      setUrl(value)
      return true
    },
    menu:
      url === null ? null : (
        <Sheet
          visible={url !== null}
          title={url ?? ''}
          onClose={() => setUrl(null)}
          actions={webLinkActions(url ?? '').map((item) => ({
            label: t(item.label),
            testID: `web-link:${item.id}`,
            onPress: () => {
              if (!url) return
              void performWebLinkAction(item.id, url, {
                copy: (value) => Clipboard.setStringAsync(value),
                open: (value) => Linking.openURL(value),
              }).catch(() =>
                Alert.alert(
                  t(item.id === 'copyLink' ? 'link.menu.copyFailed' : 'link.menu.openFailed'),
                ),
              )
            },
          }))}
        />
      ),
  }
}

/** 非网页的长按继续交还调用方，保持文件和经理编号的行为。 */
export function WebLinkMarkdown({ onLinkLongPress, ...props }: EnrichedMarkdownTextProps) {
  const links = useWebLinkMenu()
  return (
    <>
      <EnrichedMarkdownText
        {...props}
        onLinkLongPress={(event) => {
          if (!links.open(event.url)) onLinkLongPress?.(event)
        }}
      />
      {links.menu}
    </>
  )
}
