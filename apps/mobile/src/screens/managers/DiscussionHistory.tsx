import { type ReactNode, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import {
  postCollapsed,
  postSummary,
  rememberPostCollapsed,
} from '../../../../../packages/ui/src/manager/post-presentation.ts'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'

export function DiscussionHistory({
  viewKey,
  text,
  children,
}: {
  viewKey: string
  text: string
  children: ReactNode
}) {
  const t = useT()
  const { c, font, hit } = useTheme()
  const [collapsed, setCollapsed] = useState(() => postCollapsed(viewKey, text.length > 1200))
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('manager.discussion')}
          accessibilityState={{ expanded: !collapsed }}
          style={{ minHeight: hit, minWidth: hit, justifyContent: 'center', alignItems: 'center' }}
          onPress={() => {
            rememberPostCollapsed(viewKey, !collapsed)
            setCollapsed(!collapsed)
          }}
        >
          <Text style={{ color: c.ink2, fontSize: font.size.meta }}>{collapsed ? '▸' : '▾'}</Text>
        </Pressable>
        <Text numberOfLines={1} style={{ flex: 1, color: c.ink3, fontSize: font.size.meta }}>
          {t('manager.discussion')}
          {collapsed ? ` · ${postSummary(text)}` : ''}
        </Text>
      </View>
      {collapsed ? null : children}
    </View>
  )
}
