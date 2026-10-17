// 客户端工具（内置浏览器、Computer Use）要人点头的事。手机上执行不了这些工具，不会自己发起这种询问；
// 会话同时开在桌面端时，同一份请求也会排到这里（模拟核心里也有），照样能答。文字按结构在这里拼，核心只给“问的是什么”；
// 远程设备上的模型要用那台电脑时写明白（和桌面端 ClientAskCard 同样的取舍）。
import type { ApprovalOption, ClientAskRequest } from '@litch/core'
import { type Key, useT } from '../../ui/i18n'
import { Card, CardButton, type CardProps, Meta, useRespond, Well, Why } from './Card'

const OPTION_TEXT: Record<ApprovalOption['role'], Key> = {
  accept: 'clientAsk.option.once',
  acceptSession: 'clientAsk.option.session',
  acceptAlways: 'clientAsk.option.always',
  decline: 'clientAsk.option.decline',
  cancel: 'clientAsk.option.decline',
}

export function ClientAskCard(props: CardProps<ClientAskRequest>) {
  const { request, waiting } = props
  const t = useT()
  const { busy, error, respond } = useRespond(props)
  const primary = request.options.find((option) => option.role !== 'decline')
  const { ask, device } = request
  const remote = device.kind === 'ssh'
  return (
    <Card
      testID="request:clientAsk"
      title={t(ask.kind === 'site' ? 'clientAsk.site' : 'clientAsk.app')}
      waiting={waiting}
      error={error}
      actions={request.options.map((option) => (
        <CardButton
          key={option.id}
          kind={option === primary ? 'primary' : option.role === 'decline' ? 'ghost' : 'plain'}
          testID={`request:option:${option.id}`}
          label={t(OPTION_TEXT[option.role])}
          disabled={busy}
          onPress={() => respond({ optionId: option.id })}
        />
      ))}
    >
      {remote ? <Why tone="err">{t('clientAsk.remote')}</Why> : null}
      <Meta
        label={t('clientAsk.from')}
        value={remote ? `${t.text(device.name)} · ${device.host}` : t.text(device.name)}
      />
      <Meta
        label={t('clientAsk.tool')}
        value={`${request.tool.namespace} · ${request.tool.name}`}
      />
      {ask.kind === 'site' ? (
        <>
          <Meta label={t('clientAsk.origin')} value={ask.origin} />
          {ask.url && ask.url !== ask.origin ? <Well>{ask.url}</Well> : null}
        </>
      ) : (
        <>
          <Meta label={t('clientAsk.appName')} value={`${ask.app.name}  ${ask.app.bundleId}`} />
          {ask.risk === 'elevated' ? <Why tone="err">{t('clientAsk.elevated')}</Why> : null}
          {!ask.allowAlways ? <Why>{t('clientAsk.noAlways')}</Why> : null}
        </>
      )}
    </Card>
  )
}
