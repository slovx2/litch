// 通用的小控件：按钮、列表行、分组标题、输入框、空状态、状态记号。圆角、字体、选中样式、记号都跟皮肤走（src/ui/theme.ts）。
// 各页面共用；要加新的通用控件就加在 src/ui/kit/ 下（谁先要谁加，合并时由主线检查有没有重复）。
import type { ReactNode } from 'react'
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native'
import { type StatusKind, type Theme, useTheme } from '../theme'
import { useBreath } from './breath'

export function Button({
  label,
  onPress,
  kind = 'solid',
  disabled,
  busy,
  testID,
}: {
  label: string
  onPress(): void
  /** solid 实心（主要动作）；plain 只有边框；danger 危险动作（去掉、删除） */
  kind?: 'solid' | 'plain' | 'danger'
  disabled?: boolean
  busy?: boolean
  testID?: string
}) {
  const { c, hit, radius, font } = useTheme()
  const inactive = disabled || busy
  const bg = kind === 'solid' ? c.accentSolid : 'transparent'
  const fg = kind === 'solid' ? c.onAccent : kind === 'danger' ? c.err : c.ink
  const border = kind === 'danger' ? c.err : c.line3
  return (
    <Pressable
      // 安卓上忙过一次之后，读屏的“忙”不会随 busy 变回 false 清掉（uiautomator 里一直挂着 busy）：
      // 忙和不忙换一个视图
      key={busy ? 'busy' : 'idle'}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      testID={testID}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: hit,
          borderRadius: radius.m,
          backgroundColor: bg,
          borderColor: border,
          opacity: inactive ? 0.5 : pressed ? 0.75 : 1,
        },
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : null}
      <Text style={[styles.buttonText, { color: fg, fontFamily: font.ui }]}>{label}</Text>
    </Pressable>
  )
}

export function Row({
  title,
  detail,
  meta,
  left,
  right,
  onPress,
  onLongPress,
  selected,
  testID,
}: {
  title: string
  /** 第二行：说明、最后一句话 */
  detail?: string
  /** 右上角的小字：时间、数量 */
  meta?: string
  left?: ReactNode
  right?: ReactNode
  onPress?(): void
  onLongPress?(): void
  /** 选中：复古是反白，另外两种是强调色的淡底 */
  selected?: boolean
  testID?: string
}) {
  const theme = useTheme()
  const { c } = theme
  const ink = selected ? c.selFg : c.ink
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      testID={testID}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: theme.hit + 12,
          borderBottomColor: c.line1,
          backgroundColor: selected ? c.selBg : pressed ? c.press : c.panel,
        },
      ]}
    >
      {left}
      <View style={styles.rowText}>
        <View style={styles.rowTop}>
          <Text
            numberOfLines={1}
            style={[
              styles.rowTitle,
              { color: ink, fontSize: theme.font.size.body, fontFamily: theme.font.ui },
            ]}
          >
            {title}
          </Text>
          {meta ? (
            <Text
              style={[
                styles.rowMeta,
                { color: selected ? c.selFg : c.ink3, fontFamily: theme.font.mono },
              ]}
            >
              {meta}
            </Text>
          ) : null}
        </View>
        {detail ? (
          <Text
            numberOfLines={2}
            style={[styles.rowDetail, { color: selected ? c.selFg : c.ink2 }]}
          >
            {detail}
          </Text>
        ) : null}
      </View>
      {right}
    </Pressable>
  )
}

/** 分组的小标题（复古皮肤里前面带 “## ”、用等宽字） */
export function SectionLabel({ children, right }: { children: string; right?: ReactNode }) {
  const theme = useTheme()
  return (
    <View style={[styles.section, { backgroundColor: theme.c.win }]}>
      <Text style={[styles.sectionText, sectionFont(theme), { color: theme.c.ink2 }]}>
        {theme.sectionPrefix}
        {children}
      </Text>
      {right}
    </View>
  )
}

export function Field({
  label,
  hint,
  error,
  ...input
}: TextInputProps & { label: string; hint?: string; error?: string }) {
  const theme = useTheme()
  const { c } = theme
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: c.ink2 }]}>{label}</Text>
      <TextInput
        placeholderTextColor={c.ink3}
        autoCapitalize="none"
        autoCorrect={false}
        {...input}
        style={[
          styles.fieldInput,
          {
            color: c.ink,
            backgroundColor: c.raised,
            borderColor: error ? c.err : c.line2,
            borderRadius: theme.radius.m,
            minHeight: theme.hit,
          },
          input.multiline ? styles.fieldMulti : null,
          input.style,
        ]}
      />
      {error ? <Text style={[styles.fieldHint, { color: c.err }]}>{error}</Text> : null}
      {!error && hint ? <Text style={[styles.fieldHint, { color: c.ink3 }]}>{hint}</Text> : null}
    </View>
  )
}

export function Empty({
  title,
  detail,
  action,
}: {
  title: string
  detail?: string
  action?: ReactNode
}) {
  const { c } = useTheme()
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: c.ink }]}>{title}</Text>
      {detail ? <Text style={[styles.emptyDetail, { color: c.ink2 }]}>{detail}</Text> : null}
      {action}
    </View>
  )
}

/** 可选的小块：一排里选一个或几个（日程种类、星期）。选中反白 */
export function Chip({
  label,
  on,
  onPress,
  disabled,
  testID,
}: {
  label: string
  on?: boolean
  onPress?(): void
  disabled?: boolean
  testID?: string
}) {
  const { c, radius } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!on, disabled: !!disabled }}
      disabled={disabled || !onPress}
      onPress={onPress}
      testID={testID}
      hitSlop={4}
      style={({ pressed }) => [
        styles.chip,
        {
          borderColor: on ? c.line3 : c.line2,
          borderRadius: radius.s,
          backgroundColor: on ? c.selBg : pressed ? c.press : 'transparent',
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Text numberOfLines={1} style={[styles.chipText, { color: on ? c.selFg : c.ink }]}>
        {label}
      </Text>
    </Pressable>
  )
}

/** 状态记号：用形状区分（设计稿：会话状态用形状，不只靠颜色），形状跟皮肤走 */
export function StatusMark({ status }: { status: StatusKind }) {
  const { c, marks } = useTheme()
  const glyph = marks[status]
  const color = {
    idle: c.ink3,
    running: c.accent,
    waiting: c.wait,
    error: c.err,
    unread: c.seal,
    offline: c.ink3,
    background: c.accent,
  }[status]
  // 只剩后台任务在跑：慢呼吸，和前台在跑的分开
  if (status === 'background') return <BreathingMark glyph={glyph} color={color} />
  return <Text style={[styles.mark, { color }]}>{glyph}</Text>
}

function BreathingMark({ glyph, color }: { glyph: string; color: string }) {
  const breath = useBreath()
  return (
    <Animated.Text testID="mark:background" style={[styles.mark, { color, opacity: breath }]}>
      {glyph}
    </Animated.Text>
  )
}

/** 分组小标题的字：复古用等宽，人文用衬线并拉开字距，标准用系统字 */
export function sectionFont(theme: Theme) {
  if (theme.skin === 'retro') return { fontFamily: theme.font.mono }
  if (theme.skin === 'human') return { fontFamily: theme.font.ui, letterSpacing: 1.5 }
  return { fontWeight: '600' as const }
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    borderWidth: 1,
  },
  buttonText: { fontSize: 15, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  rowTitle: { flex: 1, fontWeight: '500' },
  rowMeta: { fontSize: 11 },
  rowDetail: { fontSize: 13, marginTop: 2 },
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 6,
  },
  sectionText: { fontSize: 12 },
  field: { gap: 6 },
  fieldLabel: { fontSize: 13, fontWeight: '500' },
  fieldInput: { borderWidth: 1, paddingHorizontal: 12, fontSize: 15 },
  fieldMulti: { minHeight: 120, paddingVertical: 10, textAlignVertical: 'top' },
  fieldHint: { fontSize: 12 },
  empty: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  emptyTitle: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  emptyDetail: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  mark: { width: 16, textAlign: 'center', fontSize: 12 },
  chip: { borderWidth: 1, paddingHorizontal: 10, minHeight: 34, justifyContent: 'center' },
  chipText: { fontSize: 14 },
})
