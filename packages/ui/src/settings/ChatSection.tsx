// 设置页“对话”那一组：回合进行中发的消息是立即发送（插进正在进行的回合）还是排队。
// 记在界面本地、全局一份（composer/send-mode.ts），改了当场生效，正开着的会话下一条就照新的发
import { useT } from '../app/appearance.ts'
import { setSendMode, useSendMode } from '../composer/send-mode.ts'
import { SEND_MODES } from '../composer/send-mode-logic.ts'
import { Choice, Row } from './Look.tsx'

export function ChatSection() {
  const t = useT()
  const mode = useSendMode()
  return (
    <section className="set-block">
      <div className="set-rows">
        <Row title={t('settings.chat.sendMode')} note={t('settings.chat.sendMode.note')}>
          <Choice
            name="sendMode"
            value={mode}
            options={SEND_MODES}
            label={(option) => t(`settings.chat.mode.${option}`)}
            onPick={setSendMode}
          />
        </Row>
      </div>
    </section>
  )
}
