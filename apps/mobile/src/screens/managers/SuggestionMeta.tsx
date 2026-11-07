// 看板建议卡展开后第一行小字：来源会话、设备、目录、多久以前，和桌面端同一组信息；放不下省略。
import { type DeviceView, keys, type SuggestionView } from '@litch/core'
import { Text } from 'react-native'
import { agoLong } from '../../../../../packages/ui/src/app/format.ts'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'

export function SuggestionMeta({ row }: { row: SuggestionView }) {
  const t = useT()
  const { c, font } = useTheme()
  const { deviceId, proposal, source } = row
  const device = useKey<DeviceView>(keys.device(deviceId))
  const folder =
    source.project?.name ?? source.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? source.cwd
  return (
    <Text
      testID={`suggestion-meta:${proposal.id}`}
      numberOfLines={2}
      style={{ color: c.ink3, fontSize: font.size.small + 1 }}
    >
      <Text style={{ color: c.ink2 }}>{source.title}</Text>
      {' · '}
      {device ? t.text(device.name) : deviceId}
      {' · '}
      {folder}
      {' · '}
      {agoLong(proposal.createdAt, Date.now(), t.lang)}
    </Text>
  )
}
