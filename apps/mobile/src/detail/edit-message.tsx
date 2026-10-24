// 编辑一条发过的消息再重发（长按菜单里的“编辑”打开）：弹出一个编辑框，带着原文，下面写发送后会怎样、哪些附件带不上。
// 点“发送”之前什么都不改；“取消”、点外面、系统返回键都恢复原样。规矩同桌面端（packages/ui 的 MessageEdit.tsx）：
// 发送走 session.edit，先回退到这条消息之前（插进来的话切在它之前），成了再开新回合。
// - 回退没成：编辑框和里面的字都留着，下面写原因；
// - 回退成了、发送没成：原消息已经撤掉，编辑后的文字、图片、评论放回输入框，提示原因。
import { editableOf, parseComments, resendOf, type UserMessageItem } from '@litch/core'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import type { SessionStore } from '../core/session-store'
import { useChannel } from '../shell/services'
import { useT } from '../ui/i18n'
import { Button } from '../ui/kit/controls'
import { Dialog } from '../ui/kit/overlays'
import { useTheme } from '../ui/theme'
import { UNKNOWN_ITEM } from './comments/refs'
import { refillDraft } from './refill'

/** 要编辑的那条：哪一回合、切在哪条插进来的话之前（没有 itemId 是整个回合）、原消息 */
export interface EditTarget {
  turnId: string
  itemId?: string
  user: UserMessageItem
}

const reasonOf = (error: unknown): string => {
  const { message, text } = (error ?? {}) as { message?: string; text?: unknown }
  return message || (text ? String(text) : String(error))
}

export function EditMessage({
  store,
  target,
  onClose,
  say,
}: {
  store: SessionStore
  /** null 是关着 */
  target: EditTarget | null
  onClose(): void
  say(text: string): void
}) {
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  const channel = useChannel()
  const meta = useSyncExternalStore(store.subscribeMeta, store.getMeta)
  const start = target ? editableOf(target.user) : null
  const [text, setText] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setText(start?.text ?? '')
    setError(null)
    setWorking(false)
  }, [start?.text])

  if (!target || !start) return null
  const { deviceId, sessionId } = store
  const empty = !text.trim() && start.kept.length === 0 && start.comments === 0
  const close = () => {
    if (!working) onClose()
  }

  const send = () => {
    if (working || empty) return
    // 回合在跑、harness 不会回退：不发，写明原因
    const blocked = meta?.running
      ? t('turn.busy')
      : meta?.can.rollback === false
        ? t('ability.unsupported')
        : null
    if (blocked) {
      setError(t('turn.edit.failed', { reason: blocked }))
      return
    }
    const message = resendOf(target.user, text)
    setWorking(true)
    setError(null)
    channel
      .command('session.edit', {
        deviceId,
        sessionId,
        turnId: target.turnId,
        ...(target.itemId ? { itemId: target.itemId } : {}),
        ...message,
      })
      .then(
        (result) => {
          setWorking(false)
          onClose()
          if (!result.sendFailure) return
          refillDraft(deviceId, sessionId, {
            text,
            images: message.images,
            comments: (parseComments(target.user.text)?.comments ?? []).map(({ quote, note }) => ({
              kind: 'comment',
              itemId: UNKNOWN_ITEM,
              quote,
              note,
            })),
          })
          say(t('turn.edit.sendFailed', { reason: reasonOf(result.sendFailure) }))
        },
        (failure: unknown) => {
          setWorking(false)
          setError(t('turn.edit.failed', { reason: reasonOf(failure) }))
        },
      )
  }

  const note = (words: string, color = c.ink3) => (
    <Text style={[styles.note, { color, fontSize: theme.font.size.meta }]}>{words}</Text>
  )
  return (
    <Dialog visible onClose={close}>
      <Text style={[styles.title, { color: c.ink, fontFamily: theme.font.ui }]}>
        {t('turn.edit')}
      </Text>
      <TextInput
        autoFocus
        multiline
        value={text}
        editable={!working}
        onChangeText={setText}
        accessibilityLabel={t('turn.edit.editing')}
        testID="edit:input"
        style={[
          styles.input,
          {
            color: c.ink,
            borderColor: c.line2,
            borderRadius: theme.radius.m,
            backgroundColor: c.panel,
            fontSize: theme.font.size.body,
          },
        ]}
      />
      {start.comments > 0 ? note(t('comment.sent', { n: start.comments })) : null}
      {start.kept.length > 0
        ? note(start.kept.map((one) => one.label ?? t('attachment.image')).join(t('list.comma')))
        : null}
      {start.dropped.length > 0
        ? note(
            t('turn.edit.dropped', {
              names: start.dropped
                .map((one) => one.label ?? t(`attachment.${one.kind}`))
                .join(t('list.comma')),
            }),
          )
        : null}
      {note(t(meta?.can.rollbackRestoresFiles ? 'turn.edit.noteRestores' : 'turn.edit.note'))}
      {error ? note(error, c.err) : null}
      <View style={styles.buttons}>
        <Button kind="plain" label={t('turn.edit.cancel')} onPress={close} testID="edit:cancel" />
        <Button
          label={t('turn.edit.send')}
          onPress={send}
          disabled={empty}
          busy={working}
          testID="edit:send"
        />
      </View>
    </Dialog>
  )
}

const styles = StyleSheet.create({
  title: { fontSize: 17, fontWeight: '600' },
  input: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 88,
    maxHeight: 260,
  },
  note: { lineHeight: 18 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
})
