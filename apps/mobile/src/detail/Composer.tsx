// 会话详情的输入区：排着队的消息、输入框、设置条。会话层面的状态（排队、设置、用量、能不能发、在不在跑）
// 一律从会话存储的 meta 订阅来（src/core/session-store.ts），不另开会话订阅。
// 发消息走 session.send：没有回合在跑就开一个，在跑就由核心排队；排着的可以现在就插进去（steer）、拿回来改、拿掉。
// 回合在跑而输入框是空的，按钮是“停止”（session.interrupt）。
import { type DeviceView, type ImageAttachment, keys, type QueuedMessage } from '@litch/core'
import { type RefObject, useState, useSyncExternalStore } from 'react'
import type { TextInput } from 'react-native'
import type { SessionStore } from '../core/session-store'
import { useChannel, useKey } from '../shell/services'
import { useT } from '../ui/i18n'
import { ComposeBox, useDraft } from './composer/ComposeBox'
import { draftKey } from './composer/drafts'
import { downHarness, useComposeOptions } from './composer/options'
import { QueueTray } from './composer/QueueTray'
import { reasonOf } from './composer/reason'
import { SettingsBar } from './composer/SettingsBar'

export function Composer({
  store,
  markers,
  inputRef,
}: {
  store: SessionStore
  markers: boolean
  /** 输入框：请求卡片上“带意见修改”要把焦点放进来 */
  inputRef?: RefObject<TextInput | null>
}) {
  const { deviceId, sessionId } = store
  const t = useT()
  const channel = useChannel()
  const meta = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const device = useKey<DeviceView>(keys.device(deviceId))
  const draft = useDraft(draftKey(deviceId, sessionId))
  const options = useComposeOptions(deviceId, meta?.harness)
  const [error, setError] = useState<string | null>(null)

  const running = meta?.running ?? false
  const down = downHarness(device, meta?.harness)
  const blocked =
    device && device.connection !== 'online'
      ? t('composer.offline')
      : !meta
        ? null
        : !meta.live
          ? meta.note
            ? t.text(meta.note)
            : t('composer.offline')
          : down
            ? t(down.state === 'disabled' ? 'composer.harnessOff' : 'composer.harnessDown', {
                name: down.name,
              })
            : null
  const harness = device?.harnesses.find((entry) => entry.id === meta?.harness)
  const model = options?.models.find((entry) => entry.id === meta?.settings.model)
  const imagesOff =
    harness?.abilities?.images === false
      ? t('composer.image.harness')
      : model && !model.acceptsImages
        ? t('composer.image.unsupported')
        : null

  const send = async (text: string, images: ImageAttachment[]) => {
    await channel.command('session.send', { deviceId, sessionId, text, images })
  }
  const stop = () => {
    setError(null)
    channel
      .command('session.interrupt', { deviceId, sessionId })
      .catch((reason: unknown) =>
        setError(t('composer.interruptFailed', { reason: reasonOf(reason, t) })),
      )
  }
  const steer = (message: QueuedMessage) => {
    setError(null)
    channel
      .command('session.steer', { deviceId, sessionId, messageId: message.id })
      .catch((reason: unknown) =>
        setError(t('composer.steerFailed', { reason: reasonOf(reason, t) })),
      )
  }
  const unqueue = (message: QueuedMessage, edit: boolean) => {
    channel
      .command('session.unqueue', { deviceId, sessionId, messageId: message.id })
      .catch(() => {})
    if (edit) draft.refill(message.text, message.images)
  }

  return (
    <ComposeBox
      draft={draft}
      placeholder={t(running ? 'compose.placeholderRunning' : 'compose.placeholder')}
      running={running}
      blocked={blocked}
      imagesOff={imagesOff}
      error={error}
      markers={markers}
      inputRef={inputRef}
      onSend={send}
      onStop={stop}
      onError={setError}
      top={
        meta ? (
          <QueueTray
            queued={meta.queued}
            running={running}
            canSteer={meta.can.steer}
            steerImages={meta.can.steerImages}
            onSteer={steer}
            onEdit={(message) => unqueue(message, true)}
            onRemove={(message) => unqueue(message, false)}
            onRefused={() => setError(t('composer.steer.noImages'))}
          />
        ) : null
      }
      bar={
        meta?.live ? (
          <SettingsBar
            options={options}
            settings={meta.settings}
            usage={meta.usage}
            onChange={(patch) => {
              channel
                .command('session.configure', { deviceId, sessionId, settings: patch })
                .catch((reason: unknown) => setError(reasonOf(reason, t)))
            }}
          />
        ) : null
      }
    />
  )
}
