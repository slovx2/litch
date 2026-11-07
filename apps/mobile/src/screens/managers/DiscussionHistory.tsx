import { type ReactNode, useState } from 'react'
import { Text, View } from 'react-native'
import {
  postCollapsed,
  postSummary,
  rememberPostCollapsed,
} from '../../../../../packages/ui/src/manager/post-presentation.ts'
import { useT } from '../../ui/i18n'
import { Fold } from '../../ui/kit/Icon'
import { useTheme } from '../../ui/theme'

export function DiscussionHistory({
  viewKey,
  text,
  children,
  defaultOpen = false,
}: {
  viewKey: string
  text: string
  children: ReactNode
  /** 讨论抽屉专门用来读讨论：默认展开，手动收起照样记住 */
  defaultOpen?: boolean
}) {
  const t = useT()
  const { c, font } = useTheme()
  const [collapsed, setCollapsed] = useState(() =>
    postCollapsed(viewKey, !defaultOpen && text.length > 1200),
  )
  return (
    <View>
      <Fold
        open={!collapsed}
        label={t('manager.discussion')}
        onToggle={() => {
          rememberPostCollapsed(viewKey, !collapsed)
          setCollapsed(!collapsed)
        }}
      >
        <Text numberOfLines={1} style={{ color: c.ink3, fontSize: font.size.meta }}>
          {t('manager.discussion')}
          {collapsed ? ` · ${postSummary(text)}` : ''}
        </Text>
      </Fold>
      {collapsed ? null : children}
    </View>
  )
}
