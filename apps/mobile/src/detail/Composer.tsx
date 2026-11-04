// 会话详情的输入区：排着队的消息、输入框、设置条。会话层面的状态（排队、设置、用量、能不能发、在不在跑）
// 一律从会话存储的 meta 订阅来（src/core/session-store.ts），不另开会话订阅。
// 发消息走 session.send：没有回合在跑就开一个；在跑时照设置里的“回合进行中发消息”（composer/send-mode.ts），默认带 now
// 直接插进去，选了排队或这个会话插不了话的由核心排队；排着的可以现在就插进去（steer）、拿回来改、拿掉。
// 回合在跑而输入框是空的，按钮是“停止”（session.interrupt；有在做的目标时核心先把它暂停）。
// harness 会持续目标时，输入框上方有目标那一行，`/goal 要做到的事` 截下来设目标（goal/）。

import type { SessionSettings } from '@litch/core'
import {
  type CommentExtra,
  type DeviceView,
  type ImageAttachment,
  keys,
  MAX_COMMENTS,
  MAX_IMAGES,
  type MessageExtra,
  type QueuedMessage,
} from '@litch/core'
import { type RefObject, useEffect, useState, useSyncExternalStore } from 'react'
import { StyleSheet, type TextInput, View } from 'react-native'
import { whyNot } from '../../../../packages/ui/src/app/errors.ts'
import { useProviderSwitch } from '../../../../packages/ui/src/composer/useProviderSwitch'
import type { SessionStore } from '../core/session-store'
import { useKey, useServices } from '../shell/services'
import { useT } from '../ui/i18n'
import { BackgroundBar } from './background/BackgroundBar'
import { ComposeBox, useDraft } from './composer/ComposeBox'
import { draftKey, type SessionExtra } from './composer/drafts'
import { downHarness, useComposeOptions } from './composer/options'
import { ProviderSwitch } from './composer/ProviderSwitch'
import { ProviderSwitchDialog } from './composer/ProviderSwitchDialog'

const NO_SETTINGS: SessionSettings = {
  model: null,
  effort: null,
  speed: null,
  permission: null,
  mode: null,
}

import { QueueTray } from './composer/QueueTray'
import { sendFlags, whenRunning } from './composer/send-mode'
import { GoalBar } from './goal/GoalBar'
import { SlashGoal } from './goal/SlashGoal'
import { useGoalSend } from './goal/useGoalSend'
import { QueuedNotesChip, QueuedNotesPanel } from './proposals/EventCell'
import { onRefill } from './refill'
import { TodoChip, TodoPanel } from './todo/TodoViews'

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
  const { channel, prefs } = useServices()
  const meta = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const device = useKey<DeviceView>(keys.device(deviceId))
  const draft = useDraft(draftKey(deviceId, sessionId))
  const options = useComposeOptions(deviceId, meta?.harness, sessionId)
  const [error, setError] = useState<string | null>(null)
  const [pendingSend, setPendingSend] = useState<'include' | 'only'>('include')
  // biome-ignore lint/correctness/useExhaustiveDependencies: 切换会话时恢复默认选择，不沿用另一个会话的选择
  useEffect(() => {
    setPendingSend('include')
  }, [sessionId])
  // 输入框上方的浮窗：待办或排着的回报，同时只开一个
  const [panel, setPanel] = useState<'todo' | 'notes' | null>(null)
  const toggle = (which: 'todo' | 'notes') => setPanel((open) => (open === which ? null : which))
  const { refill } = draft
  // 对话区回退了一个回合：那条消息放回输入框（src/detail/refill.ts）
  useEffect(
    () =>
      onRefill(deviceId, sessionId, (message) =>
        refill(message.text, message.images, message.comments, [], message.files),
      ),
    [deviceId, sessionId, refill],
  )

  const switching = useProviderSwitch(
    channel,
    deviceId,
    sessionId,
    meta?.harness,
    meta?.settings ?? NO_SETTINGS,
  )
  const running = meta?.running ?? false
  const heldCount = meta?.queued.filter((entry) => entry.delivery === 'held').length ?? 0
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
    (meta?.can.images ?? harness?.abilities?.images) === false
      ? t('composer.image.harness')
      : model && !model.acceptsImages
        ? t('composer.image.unsupported')
        : null

  const onRunning = whenRunning(prefs.sendMode, meta?.can)
  const send = async (text: string, images: ImageAttachment[], extras: MessageExtra[]) => {
    await channel.command('session.send', {
      deviceId,
      sessionId,
      text,
      images,
      extras,
      ...sendFlags(onRunning),
      pending: pendingSend,
    })
    setPendingSend('include')
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
    if (
      edit &&
      (draft.images.length + message.images.length > MAX_IMAGES ||
        draft.comments.length + commentsIn(message.extras).length > MAX_COMMENTS ||
        draft.files.length + draft.comments.length + draft.sessions.length + message.extras.length >
          16 ||
        message.extras.some(
          (extra) => extra.kind !== 'comment' && extra.kind !== 'session' && extra.kind !== 'file',
        ))
    ) {
      setError(t('composer.pendingDraftFull'))
      return
    }
    channel
      .command('session.unqueue', { deviceId, sessionId, messageId: message.id })
      .catch(() => {})
    if (edit)
      draft.refill(
        message.text,
        message.images,
        commentsIn(message.extras),
        sessionsIn(message.extras),
        message.extras.filter((extra) => extra.kind === 'file'),
      )
  }

  return (
    <>
      {switching.pending ? (
        <ProviderSwitchDialog
          state={switching}
          running={running}
          able={meta?.can.compact !== false}
        />
      ) : null}
      <ComposeBox
        draft={draft}
        placeholder={
          running
            ? // 手机屏窄，占位只写一句短的（桌面那句长的会被截成两行）
              t(onRunning === 'steer' ? 'compose.placeholder.steer' : 'compose.placeholder.queue')
            : t('compose.placeholder')
        }
        running={running}
        pending={
          heldCount > 0
            ? {
                count: heldCount,
                include: pendingSend === 'include',
                toggle: () => setPendingSend(pendingSend === 'include' ? 'only' : 'include'),
              }
            : null
        }
        steer={onRunning === 'steer'}
        steerImages={meta?.can.steerImages !== false}
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
              {/* 待办的浮窗：点了下面的小按钮展开，整份清单跟着待办换 */}
              {panel === 'todo' ? <TodoPanel store={store} onClose={() => setPanel(null)} /> : null}
              {/* 排着的回报的浮窗：点了下面的小按钮展开，一条一行 */}
              {panel === 'notes' ? (
                <QueuedNotesPanel
                  deviceId={deviceId}
                  sessionId={sessionId}
                  onClose={() => setPanel(null)}
                />
              ) : null}
              {/* 后台还有任务在跑（回合在不在跑都一样）：一行，只说有几个，点开进后台任务页；
                旁边是排着的子会话回报（几条合成一个）和待办的小按钮（照桌面端信息栏的待办卡片），排不下就折到下一行 */}
              <View style={styles.chips}>
                <BackgroundBar store={store} />
                <QueuedNotesChip
                  deviceId={deviceId}
                  sessionId={sessionId}
                  open={panel === 'notes'}
                  onToggle={() => toggle('notes')}
                />
                <TodoChip store={store} open={panel === 'todo'} onToggle={() => toggle('todo')} />
              </View>
              {/* 下一轮要换到别的供应商：提示一行 */}
              <ProviderSwitch
                sessionId={sessionId}
                harness={meta.harness}
                model={meta.settings.model}
                running={running}
                options={options}
              />
              <QueueTray
                queued={meta.queued}
                onResume={(messageId) => {
                  channel
                    .command('session.resumeQueue', {
                      deviceId,
                      sessionId,
                      ...(messageId ? { messageId } : {}),
                    })
                    .catch((reason: unknown) => setError(whyNot(reason, t)))
                }}
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
        settings={
          meta?.live
            ? {
                deviceId,
                harness: meta.harness ?? undefined,
                cwd: meta.cwd,
                options,
                settings: meta.settings,
                usage: meta.usage,
                ...(onUsage ? { onUsage } : {}),
                onChange: (patch) => {
                  switching.change(patch).catch((reason: unknown) => setError(whyNot(reason, t)))
                },
              }
            : null
        }
      />
    </>
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

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, paddingHorizontal: 12 },
})
