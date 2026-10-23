// 会话详情的输入区：排着队的消息、输入框、设置条。会话层面的状态（排队、设置、用量、能不能发、在不在跑）
// 一律从会话存储的 meta 订阅来（src/core/session-store.ts），不另开会话订阅。
// 发消息走 session.send：没有回合在跑就开一个，在跑就由核心排队；排着的可以现在就插进去（steer）、拿回来改、拿掉。
// 回合在跑而输入框是空的，按钮是“停止”（session.interrupt；有在做的目标时核心先把它暂停）。
// harness 会持续目标时，输入框上方有目标那一行，`/goal 要做到的事` 截下来设目标（goal/）。
import {
  type CommentExtra,
  type DeviceView,
  type ImageAttachment,
  keys,
  type MessageExtra,
  type QueuedMessage,
} from '@litch/core'
import { type RefObject, useEffect, useState, useSyncExternalStore } from 'react'
import type { TextInput } from 'react-native'
import { whyNot } from '../../../../packages/ui/src/app/errors.ts'
import type { SessionStore } from '../core/session-store'
import { useChannel, useKey } from '../shell/services'
import { useT } from '../ui/i18n'
import { BackgroundBar } from './background/BackgroundBar'
import { ComposeBox, useDraft } from './composer/ComposeBox'
import { draftKey, type SessionExtra } from './composer/drafts'
import { downHarness, useComposeOptions } from './composer/options'
import { QueueTray } from './composer/QueueTray'
import { SettingsBar } from './composer/SettingsBar'
import { GoalBar } from './goal/GoalBar'
import { SlashGoal } from './goal/SlashGoal'
import { useGoalSend } from './goal/useGoalSend'
import { onRefill } from './refill'

export function Composer({
  store,
  markers,
  inputRef,
  onUsage,
}: {
  store: SessionStore
  markers: boolean
  /** 输入框：请求卡片上“带意见修改”要把焦点放进来 */
  inputRef?: RefObject<TextInput | null>
  /** 点了“上下文 N%”：打开用量页（上下文、账号额度、压缩） */
  onUsage?(): void
}) {
  const { deviceId, sessionId } = store
  const t = useT()
  const channel = useChannel()
  const meta = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const device = useKey<DeviceView>(keys.device(deviceId))
  const draft = useDraft(draftKey(deviceId, sessionId))
  const options = useComposeOptions(deviceId, meta?.harness)
  const [error, setError] = useState<string | null>(null)
  const { refill } = draft
  // 对话区回退了一个回合：那条消息放回输入框（src/detail/refill.ts）
  useEffect(
    () =>
      onRefill(deviceId, sessionId, (message) =>
        refill(message.text, message.images, message.comments),
      ),
    [deviceId, sessionId, refill],
  )

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

  const send = async (text: string, images: ImageAttachment[], extras: MessageExtra[]) => {
    await channel.command('session.send', { deviceId, sessionId, text, images, extras })
  }
  // 输入框里的 /goal 截在这里设目标（harness 会才截），换掉没做完的目标前问的那个对话框也在这里画
  const goal = useGoalSend(deviceId, sessionId, meta, send)
  const goalsAble = meta?.can.goals === true && meta.live
  const stop = () => {
    setError(null)
    channel
      .command('session.interrupt', { deviceId, sessionId })
      .catch((reason: unknown) =>
        setError(t('composer.interruptFailed', { reason: whyNot(reason, t) })),
      )
  }
  const steer = (message: QueuedMessage) => {
    setError(null)
    channel
      .command('session.steer', { deviceId, sessionId, messageId: message.id })
      .catch((reason: unknown) =>
        setError(t('composer.steerFailed', { reason: whyNot(reason, t) })),
      )
  }
  const unqueue = (message: QueuedMessage, edit: boolean) => {
    channel
      .command('session.unqueue', { deviceId, sessionId, messageId: message.id })
      .catch(() => {})
    if (edit)
      draft.refill(
        message.text,
        message.images,
        commentsIn(message.extras),
        sessionsIn(message.extras),
      )
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
      mentions={{ deviceId, sessionId }}
      onSend={goal.send}
      onStop={stop}
      onError={setError}
      top={
        meta ? (
          <>
            {goal.confirm}
            {/* 斜杠单子：刚打了 / 开头的一个词，harness 会目标时给出 /goal */}
            <SlashGoal text={draft.text} able={goalsAble} onPick={draft.setText} />
            {/* 会话的持续目标：状态、用时、目标的话，暂停或继续、清除 */}
            <GoalBar store={store} onError={setError} />
            {/* 后台还有任务在跑（回合在不在跑都一样）：一行，只说有几个，点开从底部列出来 */}
            <BackgroundBar store={store} />
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
          </>
        ) : null
      }
      bar={
        meta?.live ? (
          <SettingsBar
            options={options}
            settings={meta.settings}
            usage={meta.usage}
            {...(onUsage ? { onUsage } : {})}
            onChange={(patch) => {
              channel
                .command('session.configure', { deviceId, sessionId, settings: patch })
                .catch((reason: unknown) => setError(whyNot(reason, t)))
            }}
          />
        ) : null
      }
    />
  )
}

const commentsIn = (extras: MessageExtra[]): CommentExtra[] =>
  extras.filter((extra): extra is CommentExtra => extra.kind === 'comment')

const sessionsIn = (extras: MessageExtra[]): SessionExtra[] =>
  extras.flatMap((extra) =>
    extra.kind === 'session'
      ? [{ kind: 'session', threadId: extra.threadId, title: extra.title }]
      : [],
  )
