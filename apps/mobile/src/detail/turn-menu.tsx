// 长按一个回合出来的菜单（复制、分叉、编辑），看大图，和对话区底部一闪而过的提示。
// 能不能分叉、编辑照会话的声明：声明了不会的不出这一项；没声明的留着，对面说不认识了点了说为什么（照桌面端）。
// 从回合进行中插进来的话上长按出来的，复制、分叉、编辑对的是这条话（turn-target.ts）。
// 编辑在弹出的编辑框里改了再重发（edit-message.tsx），确认发送之前什么都不改。
// 从一条回答上长按出来的，头两项是“选择文字”（这条回答变得能自由选字，选中后系统菜单里点“回复”引用到输入框）
// 和“评论这条回答”（打开全文页选一段加评论，comments/）。
import * as Clipboard from 'expo-clipboard'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import type { SessionStore } from '../core/session-store'
import { useChannel } from '../shell/services'
import { useT } from '../ui/i18n'
import { Sheet, type SheetAction } from '../ui/kit/overlays'
import { useTheme } from '../ui/theme'
import { useComments } from './comments/context'
import { pressedItem } from './comments/hub'
import { EditMessage, type EditTarget } from './edit-message'
import { turnTarget } from './turn-target'

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
  /** 在编辑的那条：哪一回合，切在哪条插进来的话之前（没有 itemId 是整个回合） */
  const [editing, setEditing] = useState<EditTarget | null>(null)
  const comments = useComments()
  const { deviceId, sessionId } = store
  /** 现在做不了的原因。能做是 null */
  const blocked = (able: boolean | undefined): string | null =>
    able === false ? t('ability.unsupported') : meta?.running ? t('turn.busy') : null

  const actions: SheetAction[] = []
  const pressed = turnId ? pressedItem(turnId) : null
  if (turnId && comments && pressed && store.kindOf(pressed) === 'agentMessage') {
    actions.push({
      label: t('comment.select'),
      testID: 'menu:select',
      onPress: () => comments.select(pressed),
    })
    actions.push({
      label: t('comment.menu'),
      testID: 'menu:comment',
      onPress: () => comments.pick(pressed),
    })
  }
  const target = turnId ? turnTarget(store, meta?.can, turnId, pressed) : null
  if (turnId && target) {
    const { user, fork, rollback: back } = target
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
    if (fork) {
      actions.push({
        label: t('turn.fork'),
        testID: 'menu:fork',
        onPress: () => {
          const why = blocked(meta?.can.fork)
          if (why) return say(why)
          say(t('detail.forked.going'))
          channel.command('session.fork', { deviceId, sessionId, turnId, ...fork }).then(
            (result) => {
              say(t('turn.fork.done'))
              onForked(result.sessionId)
            },
            (error: unknown) => say(t('turn.fork.failed', { reason: reasonOf(error) })),
          )
        },
      })
    }
    if (back && user) {
      actions.push({
        label: t('turn.edit'),
        testID: 'menu:edit',
        onPress: () => {
          const why = blocked(meta?.can.rollback)
          if (why) say(why)
          else setEditing({ turnId, ...back, user })
        },
      })
    }
  }

  const preview = target?.user?.text.trim()
  return (
    <>
      <Sheet
        visible={turnId !== null}
        title={preview ? preview.slice(0, 120) : undefined}
        actions={actions}
        onClose={onClose}
      />
      <EditMessage store={store} target={editing} onClose={() => setEditing(null)} say={say} />
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
