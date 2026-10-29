// 客户端工具（内置浏览器等）要人点头的事。手机上执行不了这些工具，不会自己发起这种询问；
// 会话同时开在桌面端时，同一份请求也会排到这里（模拟核心里也有），照样能答。文字按结构在这里拼，核心只给“问的是什么”；
// 远程设备上的模型要用那台电脑时写明白（和桌面端 ClientAskCard 同样的取舍）。
// 操作那台桌面端的命令与文件（ask.kind 是 machine）也会排到这里：写出要做的事，选项的说法照桌面端的那一套。
// 代理请人登录（ask.kind 是 signIn）只能在桌面端登录，这里只能拒绝（核心只给拒绝一个选项）；手机远程批准开着时，
// 批准走 approvals/ 那张卡片，排在这张前面。
import type { ApprovalOption, ClientAskRequest, MachineAskView } from '@litch/core'
import { type Key, useT } from '../../ui/i18n'
import { Card, CardButton, type CardProps, Meta, useRespond, Well, Why } from './Card'

const OPTION_TEXT: Record<ApprovalOption['role'], Key> = {
  accept: 'clientAsk.option.once',
  acceptSession: 'clientAsk.option.session',
  acceptAlways: 'clientAsk.option.always',
  decline: 'clientAsk.option.decline',
  cancel: 'clientAsk.option.decline',
}

const MACHINE_TITLE: Record<MachineAskView['action'], Key> = {
  exec: 'machine.ask.exec',
  read: 'machine.ask.read',
  write: 'machine.ask.write',
  list: 'machine.ask.list',
  copy: 'machine.ask.copy',
  process: 'machine.ask.process',
}

const MACHINE_OPTION_TEXT: Record<ApprovalOption['role'], Key> = {
  accept: 'machine.option.once',
  acceptSession: 'machine.option.session',
  acceptAlways: 'clientAsk.option.always',
  decline: 'machine.option.decline',
  cancel: 'machine.option.decline',
}

export function ClientAskCard(props: CardProps<ClientAskRequest>) {
  const { request, waiting } = props
  const t = useT()
  const { busy, error, respond } = useRespond(props)
  const primary = request.options.find((option) => option.role !== 'decline')
  const { ask, device } = request
  const remote = device.kind === 'ssh'
  const optionText = ask.kind === 'machine' ? MACHINE_OPTION_TEXT : OPTION_TEXT
  return (
    <Card
      testID="request:clientAsk"
      title={t(
        ask.kind === 'chromeInstance'
          ? 'chrome.instance'
          : ask.kind === 'chromeSignIn'
            ? 'chrome.signIn'
            : ask.kind === 'site'
              ? ask.browser === 'chrome'
                ? 'chrome.approve'
                : 'clientAsk.site'
              : ask.kind === 'machine'
                ? MACHINE_TITLE[ask.action]
                : 'signInAsk.title',
      )}
      waiting={waiting}
      error={error}
      actions={request.options.map((option) => (
        <CardButton
          key={option.id}
          kind={option === primary ? 'primary' : option.role === 'decline' ? 'ghost' : 'plain'}
          testID={`request:option:${option.id}`}
          label={t(
            ask.kind === 'chromeSignIn' && option.role === 'accept'
              ? 'chrome.signInDone'
              : optionText[option.role],
          )}
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
      ) : ask.kind === 'machine' ? (
        <MachineWhat ask={ask} />
      ) : ask.kind === 'chromeInstance' ? (
        <>
          <Meta label={t('chrome.title')} value={ask.name} />
          <Why>{t('chrome.instanceNote')}</Why>
        </>
      ) : ask.kind === 'chromeSignIn' ? (
        <>
          <Meta label={t('clientAsk.origin')} value={ask.origin} />
          {ask.reason ? <Well>{ask.reason}</Well> : null}
          <Why>{t('chrome.signInNote')}</Why>
        </>
      ) : (
        <>
          <Meta label={t('clientAsk.origin')} value={ask.origin} />
          {ask.reason ? <Well>{ask.reason}</Well> : null}
          <Why>{t('signInAsk.desktopOnly')}</Why>
        </>
      )}
    </Card>
  )
}

/** 操作那台电脑要做的事：命令和目录、路径、复制的两头，提到了禁止的位置标红 */
function MachineWhat({ ask }: { ask: MachineAskView }) {
  const t = useT()
  return (
    <>
      {ask.flagged.length > 0 ? (
        <Why tone="err">{`${t('machine.ask.flagged')}：${ask.flagged.join('、')}`}</Why>
      ) : null}
      {ask.copy ? (
        <>
          <Meta
            label={t('machine.ask.from')}
            value={`${ask.copy.from.machine}  ${ask.copy.from.path}`}
          />
          <Meta label={t('machine.ask.to')} value={`${ask.copy.to.machine}  ${ask.copy.to.path}`} />
        </>
      ) : null}
      {ask.command !== null ? <Well>{ask.command}</Well> : null}
      {ask.cwd ? <Meta label={t('machine.ask.cwd')} value={ask.cwd} /> : null}
      {ask.path ? <Meta label={t('machine.ask.path')} value={ask.path} /> : null}
    </>
  )
}
