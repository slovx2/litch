// 待办的几处画法（判断在 logic.ts）：
// - TodoChip：输入框上方、后台任务那一行旁边的小按钮“待办 2/6”，会话里最近那份待办还有没做完的、或者它的回合还在跑时出；
// - TodoPanel：点了小按钮在输入框上方展开的浮窗，整份清单，跟着待办实时换，点“收起”或再点小按钮收回去；
// - TodoSteps：清单本身，浮窗和对话里展开的那一行共用。
// 照桌面端右侧信息栏的待办卡片：对话里不再画整块，只留一行（cells.tsx 的 TodoCell）。
import type { TodoStep } from '@litch/core'
import { useSyncExternalStore } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { SessionStore } from '../../core/session-store'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { stepStatus, todoChipShown, todoProgress } from './logic'

/** 清单：每步一行，记号加文字；正在做的加粗，做完的划掉 */
export function TodoSteps({
  note,
  steps,
  running,
}: {
  note: string | null
  steps: readonly TodoStep[]
  running: boolean
}) {
  const { c, font, todo } = useTheme()
  return (
    <>
      {note ? (
        <Text style={{ color: c.ink2, fontSize: font.size.meta, lineHeight: 19 }}>{note}</Text>
      ) : null}
      {steps.map((step, index) => {
        const status = stepStatus(step, running)
        return (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: 待办整份换，按位置对就行
            key={index}
            style={styles.step}
          >
            <Text style={[styles.mark, { color: c.ink3, fontFamily: font.mono }]}>
              {todo[status]}
            </Text>
            <Text
              style={[
                styles.grow,
                {
                  color: status === 'completed' ? c.ink3 : c.ink,
                  fontSize: font.size.meta + 1,
                  lineHeight: 20,
                  fontWeight: status === 'inProgress' ? '600' : 'normal',
                  textDecorationLine: status === 'completed' ? 'line-through' : 'none',
                },
              ]}
            >
              {step.text}
            </Text>
          </View>
        )
      })}
    </>
  )
}

/** 最近那份待办（会话存储里订的） */
export const useLatestTodo = (store: SessionStore) =>
  useSyncExternalStore(store.subscribeTodo, store.getTodo)

/** 输入框上方的小按钮：“待办 2/6”，点了开关浮窗 */
export function TodoChip({
  store,
  open,
  onToggle,
}: {
  store: SessionStore
  open: boolean
  onToggle(): void
}) {
  const t = useT()
  const theme = useTheme()
  const { c, font } = theme
  const todo = useLatestTodo(store)
  if (!todo || !todoChipShown(todo)) return null
  const { done, total } = todoProgress(todo.item.steps)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={t('detail.todo.chipLabel', { done, total })}
      testID="todo:chip"
      onPress={onToggle}
      style={({ pressed }) => [
        styles.chip,
        {
          borderColor: open ? c.ink2 : c.line2,
          backgroundColor: pressed ? c.press : open ? c.raised : 'transparent',
          borderRadius: theme.radius.m,
        },
      ]}
    >
      <Text style={{ color: c.ink3, fontFamily: font.mono, fontSize: 13 }}>
        {done === total ? theme.todo.completed : theme.todo.inProgress}
      </Text>
      <Text style={[styles.chipText, { color: c.ink }]}>
        {t('detail.todo.chip', { done, total })}
      </Text>
      <Text style={{ color: c.ink3 }}>{open ? '▾' : '▴'}</Text>
    </Pressable>
  )
}

/** 浮窗：整份清单。待办没了（被清空、回退掉）就不画 */
export function TodoPanel({ store, onClose }: { store: SessionStore; onClose(): void }) {
  const t = useT()
  const theme = useTheme()
  const { c, font } = theme
  const todo = useLatestTodo(store)
  if (!todo || !todoChipShown(todo)) return null
  const { done, total } = todoProgress(todo.item.steps)
  return (
    <View
      testID="todo:panel"
      style={[
        styles.panel,
        { borderColor: c.line2, backgroundColor: c.raised, borderRadius: theme.radius.l },
      ]}
    >
      <View style={styles.head}>
        <Text
          style={[styles.grow, { color: c.ink2, fontSize: font.size.meta, fontFamily: font.mono }]}
        >
          {t('todo.title')} · {t('todo.count', { done, total })}
        </Text>
        <Pressable
          accessibilityRole="button"
          testID="todo:close"
          onPress={onClose}
          hitSlop={8}
          style={({ pressed }) => [styles.close, pressed ? { backgroundColor: c.press } : null]}
        >
          <Text style={{ color: c.accent, fontSize: font.size.meta }}>
            {t('detail.group.collapse')}
          </Text>
        </Pressable>
      </View>
      <ScrollView style={styles.list} contentContainerStyle={styles.listBody}>
        <TodoSteps note={todo.item.note} steps={todo.item.steps} running={todo.running} />
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  step: { flexDirection: 'row', gap: 8 },
  mark: { fontSize: 13, lineHeight: 20 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 32,
    paddingHorizontal: 10,
    marginBottom: 6,
    borderWidth: 1,
  },
  chipText: { fontSize: 13, fontWeight: '500' },
  panel: { marginHorizontal: 12, marginBottom: 6, borderWidth: 1, paddingVertical: 8 },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8 },
  close: { paddingHorizontal: 6, paddingVertical: 2 },
  // 清单长了在浮窗里自己滚，不把对话区挤没
  list: { maxHeight: 240, marginTop: 4 },
  listBody: { paddingHorizontal: 12, gap: 4 },
})
