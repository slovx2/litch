// 手机仅处理自身访问审批和网站状态；旧代理代填卡片安全忽略。
import type { ApprovalCardView } from '../../../../../packages/protocol/src/client-approvals.mts'
import { useT } from '../../ui/i18n'
import { Card, Why } from '../requests/Card'
import { ComputerSelfApprovalCard } from './ComputerSelfApprovalCard'

export function SignInApprovalCard(props: {
  deviceId: string
  card: ApprovalCardView
  waiting: number
}) {
  const t = useT()
  if (props.card.kind === 'browserSite')
    return (
      <Card
        title={t('clientAsk.site')}
        waiting={props.waiting}
        actions={null}
        error={null}
        testID="request:browserSite"
      >
        <Why>{props.card.summary.origin}</Why>
        <Why>{t('approval.siteDesktop')}</Why>
      </Card>
    )
  return props.card.kind === 'computerSelf' ? (
    <ComputerSelfApprovalCard {...props} card={props.card} />
  ) : null
}
