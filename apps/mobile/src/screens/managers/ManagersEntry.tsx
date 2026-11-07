// 首页设备列表上方的经理入口：所有设备进行中经理的待处理合计（同 D-29 口径，报告未读不计）。
import { keys } from '@litch/core'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Row } from '../../ui/kit/controls'
import { StatusMark } from '../../ui/kit/marks'

export function ManagersEntry({ onPress }: { onPress(): void }) {
  const t = useT()
  const pending = useKey<number>(keys.managersPending) ?? 0
  const active = useKey<{ active: number }>(keys.managersSummary)?.active ?? 0
  return (
    <Row
      title={t('manager.title')}
      testID="devices:managers"
      detail={
        pending > 0
          ? t('manager.pending', { n: pending })
          : active > 0
            ? t('mgr.entry.active', { count: active })
            : t('mgr.entry.none')
      }
      left={<StatusMark status={pending > 0 ? 'waiting' : 'idle'} />}
      onPress={onPress}
    />
  )
}
