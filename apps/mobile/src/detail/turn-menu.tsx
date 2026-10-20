// 长按一个回合出来的菜单（复制、分叉、回退），看大图，和对话区底部一闪而过的提示。
// 能不能分叉、回退照会话的声明：声明了不会的不出这一项；没声明的留着，对面说不认识了点了说为什么（照桌面端）。
// 从一条回答上长按出来的，第一项是“评论这条回答”：打开全文页选一段加评论（comments/）。
import { parseComments } from '@litch/core'
import * as Clipboard from 'expo-clipboard'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import type { SessionStore } from '../core/session-store'
import { useChannel } from '../shell/services'
import { useT } from '../ui/i18n'
import { Confirm, Sheet, type SheetAction } from '../ui/kit/overlays'
import { useTheme } from '../ui/theme'
import { useComments } from './comments/context'
import { pressedAnswer } from './comments/hub'
import { UNKNOWN_ITEM } from './comments/refs'
import { refillDraft } from './refill'

export const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export function TurnMenu({
  store,
  turnId,
  onClose,
  onForked,
  say,
}: {
  store: SessionStore
  /** 哪一回合的菜单。null 是关着 */
  turnId: string | null
  onClose(): void
  /** 分叉成了：到新会话去 */
  onForked(sessionId: string): void
  say(text: string): void
}) {
  const t = useT()
  const channel = useChannel()
  const meta = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const [asking, setAsking] = useState<string | null>(null)
  const comments = useComments()
  const { deviceId, sessionId } = store
  const declared = meta?.can.declared === true
  /** 现在做不了的原因。能做是 null */
  const blocked = (able: boolean | undefined): string | null =>
    able === false ? t('ability.unsupported') : meta?.running ? t('turn.busy') : null

  const actions: SheetAction[] = []
  const pressedItem = turnId ? pressedAnswer(turnId) : null
  if (turnId && comments && pressedItem && store.kindOf(pressedItem) === 'agentMessage') {
    actions.push({
      label: t('comment.menu'),
      testID: 'menu:comment',
      onPress: () => comments.pick(pressedItem),
    })
  }
  if (turnId) {
    const user = store.userMessage(turnId)
    const answer = store.answerText(turnId)
    const copy = (text: string) => {
      Clipboard.setStringAsync(text).then(
        () => say(t('detail.menu.copied')),
        (error: unknown) => say(reasonOf(error)),
      )
    }
    if (answer) actions.push({ label: t('detail.menu.copyAnswer'), onPress: () => copy(answer) })
    if (user?.text)
      actions.push({ label: t('detail.menu.copyMessage'), onPress: () => copy(user.text) })
    if (!(declared && meta?.can.fork === false)) {
      actions.push({
        label: t('turn.fork'),
        testID: 'menu:fork',
        onPress: () => {
          const why = blocked(meta?.can.fork)
          if (why) return say(why)
          say(t('detail.forked.going'))
          channel.command('session.fork', { deviceId, sessionId, turnId }).then(
            (result) => {
              say(t('turn.fork.done'))
              onForked(result.sessionId)
            },
            (error: unknown) => say(t('turn.fork.failed', { reason: reasonOf(error) })),
          )
        },
      })
    }
    if (!(declared && meta?.can.rollback === false)) {
      actions.push({
        label: t('turn.rollback'),
        danger: true,
        testID: 'menu:rollback',
        onPress: () => {
          const why = blocked(meta?.can.rollback)
          if (why) say(why)
          else setAsking(turnId)
        },
      })
    }
  }

  const rollback = (turnId: string) => {
    // 回退之后这条消息就不在了：先把它拿在手里，成了放回输入框给用户改
    const user = store.userMessage(turnId)
    channel.command('session.rollback', { deviceId, sessionId, turnId }).then(
      () => {
        if (!user) return
        // 带着评论的，评论放回输入框上面，正文只放打的字
        const parsed = parseComments(user.text)
        refillDraft(deviceId, sessionId, {
          text: parsed ? parsed.rest : user.text,
          images: user.attachments.flatMap((each) =>
            each.kind === 'image' && each.url ? [{ url: each.url, name: each.label }] : [],
          ),
          comments: (parsed?.comments ?? []).map(({ quote, note }) => ({
            kind: 'comment',
            itemId: UNKNOWN_ITEM,
            quote,
            note,
          })),
        })
      },
      (error: unknown) => say(t('turn.rollback.failed', { reason: reasonOf(error) })),
    )
  }

  const preview = turnId ? store.userMessage(turnId)?.text.trim() : undefined
  return (
    <>
      <Sheet
        visible={turnId !== null}
        title={preview ? preview.slice(0, 120) : undefined}
        actions={actions}
        onClose={onClose}
      />
      <Confirm
        visible={asking !== null}
        title={t('turn.rollback.askTitle')}
        detail={t('turn.rollback.askNote')}
        confirmLabel={t('turn.rollback.yes')}
        danger
        onConfirm={() => asking && rollback(asking)}
        onClose={() => setAsking(null)}
      />
    </>
  )
}

/** 看大图：点哪里都关上 */
export function ImageViewer({ url, onClose }: { url: string | null; onClose(): void }) {
  const t = useT()
  return (
    <Modal visible={url !== null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={styles.viewer}
        onPress={onClose}
        accessibilityLabel={t('detail.image.close')}
        testID="image-viewer"
      >
        {url ? <Image source={{ uri: url }} style={styles.full} resizeMode="contain" /> : null}
      </Pressable>
    </Modal>
  )
}

/** 对话区底部一闪而过的一句话，同一时间只有一句，新的顶掉旧的 */
export function Flash({ text, onDone }: { text: string | null; onDone(): void }) {
  const { c, font } = useTheme()
  useEffect(() => {
    if (!text) return
    const timer = setTimeout(onDone, 3500)
    return () => clearTimeout(timer)
  }, [text, onDone])
  if (!text) return null
  return (
    <View pointerEvents="none" style={styles.flashWrap}>
      <Text
        style={[
          styles.flash,
          { backgroundColor: c.invBg, color: c.invFg, fontSize: font.size.meta },
        ]}
      >
        {text}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  viewer: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  full: { width: '100%', height: '100%' },
  flashWrap: { position: 'absolute', left: 16, right: 16, bottom: 16, alignItems: 'center' },
  flash: { paddingHorizontal: 14, paddingVertical: 8, maxWidth: '100%' },
})
