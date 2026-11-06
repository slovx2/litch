// 回合进行中发的消息先排在核心里，回合结束按顺序发。这里一条一行（单行截断），行尾是图标按钮：
// 立即插入（插进正在跑的回合，harness 会引导的话）、编辑（拿回输入框）、移除；停止后的待发多一个“发送”。
// 排着的消息归核心管，这里只发命令、不自己记。“连同待发一起发”是输入框发送键旁的小开关（ComposeBox）。
import type { QueuedMessage } from '@litch/core'
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { mentionRanges } from '../../../../../packages/ui/src/composer/mention-field.ts'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { DeliveryMark } from '../DeliveryMark'

/** 行尾的图标按钮：记号 36 见方，四边放 4，可点 44；读屏名称写动作 */
function Act({
  glyph,
  label,
  onPress,
  testID,
  muted,
}: {
  glyph: string
  label: string
  onPress(): void
  testID: string
  muted?: boolean
}) {
  const { c, radius } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        styles.act,
        { borderRadius: radius.s, backgroundColor: pressed ? c.press : 'transparent' },
      ]}
    >
      <Text style={[styles.actText, { color: muted ? c.ink3 : c.ink2 }]}>{glyph}</Text>
    </Pressable>
  )
}

export function QueueTray({
  queued,
  running,
  canSteer,
  steerImages,
  onSteer,
  onEdit,
  onRemove,
  onRefused,
  onResume,
}: {
  queued: QueuedMessage[]
  running: boolean
  /** 会不会引导（声明了不会、或者试过对面不认识，就没有“立即插入”） */
  canSteer: boolean
  /** 引导的时候带不带得了图片 */
  steerImages: boolean
  onSteer(message: QueuedMessage): void
  onEdit(message: QueuedMessage): void
  onRemove(message: QueuedMessage): void
  /** 带图的那条插不进去：说一句为什么 */
  onRefused(): void
  onResume(messageId?: string): void
}) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  if (queued.length === 0) return null
  const heldCount = queued.filter((entry) => entry.delivery === 'held').length
  return (
    <View testID="queue" style={[styles.tray, { borderBottomColor: c.line1 }]}>
      {/* 停止后的待发：一行头“‖ N 条待发 · 全部发送”。只是排队时没有标题行，第一行前面写“◷ N” */}
      {heldCount ? (
        <View style={styles.head}>
          <Text style={[styles.headText, { color: c.ink2 }]}>
            <Text style={{ fontFamily: theme.font.mono }}>‖ </Text>
            {t('composer.pendingCount', { n: heldCount })} ·
          </Text>
          <Pressable
            accessibilityRole="button"
            testID="queue:send"
            hitSlop={{ left: 8, right: 8 }}
            onPress={() => onResume()}
            style={styles.link}
          >
            <Text style={[styles.headText, { color: c.accent }]}>
              {t('composer.pendingSendAll')}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {queued.map((message, index) => {
        const stuck = !steerImages && message.images.length > 0
        const notes = message.extras.filter((extra) => extra.kind === 'comment').length
        // 只带评论的那条没有字：写几条评论
        const text =
          message.text ||
          (notes
            ? t('comment.count', { n: notes })
            : t('composer.imageCount', { n: message.images.length }))
        return (
          <View key={message.id} style={styles.row} testID={`queue:${index}`}>
            {heldCount ? null : (
              <Text
                accessibilityLabel={
                  index === 0 ? `${t('composer.queued')} ${queued.length}` : undefined
                }
                style={[styles.lead, { color: c.ink3, fontFamily: theme.font.mono }]}
              >
                {index === 0 ? `◷ ${queued.length}` : ''}
              </Text>
            )}
            <Text numberOfLines={1} style={[styles.text, { color: c.ink2 }]}>
              <Mentioned message={message} text={text} />
              {message.images.length > 0 && message.text
                ? `  [${t('composer.imageCount', { n: message.images.length })}]`
                : null}
            </Text>
            {/* 状态只在“说不准”时标一下：排队、停止待发已经写在头上，不每行重复 */}
            {message.delivery === 'unknown' ? <DeliveryMark delivery="unknown" /> : null}
            {message.delivery === 'held' ? (
              <Act
                testID={`queue:${index}:send`}
                glyph="↑"
                label={t('composer.send')}
                onPress={() => onResume(message.id)}
              />
            ) : null}
            {running && canSteer && !message.delivery ? (
              <Act
                testID={`queue:${index}:steer`}
                // 插进当前回合：拐角回车，和待发那一行的“发送”（↑）分开（桌面同样）
                glyph="⏎"
                label={t('composer.steer')}
                muted={stuck}
                onPress={() => (stuck ? onRefused() : onSteer(message))}
              />
            ) : null}
            <Act
              testID={`queue:${index}:edit`}
              glyph="✎"
              label={t('composer.editQueued')}
              onPress={() => onEdit(message)}
            />
            <Act
              testID={`queue:${index}:remove`}
              glyph="✕"
              label={t('composer.unqueue')}
              onPress={() => onRemove(message)}
            />
          </View>
        )
      })}
      {queued.some((entry) => entry.delivery === 'unknown') ? (
        <Text style={{ color: c.ink3 }}>{t('composer.pendingUnknown')}</Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  tray: { paddingHorizontal: 12, paddingBottom: 4, marginBottom: 6, borderBottomWidth: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 },
  headText: { fontSize: 12 },
  // 可点 44 高、至少 44 宽，上下各让出 6：头一行看着仍是 32 高（网页预览不认 hitSlop，所以不靠它补高）
  link: {
    minHeight: 44,
    minWidth: 44,
    marginVertical: -6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 36 },
  lead: { width: 34, fontSize: 12 },
  text: { flex: 1, fontSize: 13, marginRight: 4 },
  act: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  actText: { fontSize: 17 },
})

/** 排着的那句话：提到的会话（@[标题]）和对话里一样写成强调色的 ＠标题 */
function Mentioned({ message, text }: { message: QueuedMessage; text: string }) {
  const { c } = useTheme()
  const ranges = mentionRanges(
    text,
    message.extras.flatMap((extra) => (extra.kind === 'session' ? [extra] : [])),
  )
  if (ranges.length === 0) return <>{text}</>
  const parts: ReactNode[] = []
  let at = 0
  for (const range of ranges) {
    if (range.start > at) parts.push(text.slice(at, range.start))
    parts.push(
      <Text key={`m${range.start}`} style={{ color: c.accent, fontWeight: '600' }}>
        {`＠${range.title}`}
      </Text>,
    )
    at = range.end
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}
