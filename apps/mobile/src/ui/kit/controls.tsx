// 通用的小控件：按钮、列表行、分组标题、输入框、空状态。圆角、字体、选中样式都跟皮肤走（src/ui/theme.ts）；记号在 marks.tsx。
// 各页面共用；要加新的通用控件就加在 src/ui/kit/ 下（谁先要谁加，合并时由主线检查有没有重复）。
import { isValidElement, type ReactNode, type Ref } from 'react'
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native'
import { useT } from '../i18n'
import { type Theme, useTheme } from '../theme'
import { ActionRow } from './ActionRow'
import { Icon, IconButton } from './Icon'
import { rowAccessibility } from './row-accessibility'

export function Button({
  label,
  onPress,
  kind = 'solid',
  disabled,
  busy,
  spoken,
  testID,
}: {
  label: string
  onPress(): void
  /** solid 实心（主要动作）；plain 只有边框；danger 危险动作（去掉、删除）；
   *  quiet 没有边框的次要动作（卡片操作栏里主按钮旁的忽略、回复），触控高度照旧 */
  kind?: 'solid' | 'plain' | 'danger' | 'quiet'
  disabled?: boolean
  busy?: boolean
  /** 读屏名称和字不一样时给（比如不能点时写明原因）；不给就读字 */
  spoken?: string
  testID?: string
}) {
  const { c, hit, radius, font } = useTheme()
  const inactive = disabled || busy
  const bg = kind === 'solid' ? c.accentSolid : 'transparent'
  const fg =
    kind === 'solid' ? c.onAccent : kind === 'danger' ? c.err : kind === 'quiet' ? c.ink2 : c.ink
  const border = kind === 'danger' ? c.err : kind === 'quiet' ? 'transparent' : c.line3
  return (
    <Pressable
      // 安卓上忙过一次之后，读屏的“忙”不会随 busy 变回 false 清掉（uiautomator 里一直挂着 busy）：
      // 忙和不忙换一个视图
      key={busy ? 'busy' : 'idle'}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      {...(spoken ? { accessibilityLabel: spoken } : {})}
      testID={testID}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        kind === 'quiet' ? styles.quiet : null,
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
      <Text
        style={[
          styles.buttonText,
          kind === 'quiet' ? styles.quietText : null,
          { color: fg, fontFamily: font.ui },
        ]}
      >
        {label}
      </Text>
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
  label,
  trail,
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
  /** 读屏念的整行名称；不给就由各段文字拼成 */
  label?: string
  /**
   * 行尾记号：forward 进到别处（新页面、选择单），external 跳出应用，none 不画。
   * 不给时：能点、没有 right、也不是选择项（selected 没给）就画 forward
   */
  trail?: 'forward' | 'external' | 'none'
  testID?: string
}) {
  const theme = useTheme()
  const { c } = theme
  const ink = selected ? c.selFg : c.ink
  const shownTrail =
    trail ?? (onPress && right === undefined && selected === undefined ? 'forward' : 'none')
  const accessibility = rowAccessibility(
    Platform.OS,
    Boolean(onPress),
    Boolean(onLongPress),
    isValidElement<{ accessibilityLabel?: string }>(right) &&
      right.type === Switch &&
      right.props.accessibilityLabel === title,
  )
  const trailIcon =
    shownTrail === 'none' ? null : (
      <Icon
        name={shownTrail}
        size={shownTrail === 'forward' ? 14 : 16}
        color={selected ? c.selFg : c.ink3}
      />
    )
  return (
    <ActionRow
      actionGap={12}
      action={
        right ? (
          <>
            {right}
            {trailIcon}
          </>
        ) : undefined
      }
      containerStyle={{ backgroundColor: selected ? c.selBg : c.panel, borderBottomColor: c.line1 }}
      actionStyle={styles.rowAction}
      accessible={accessibility.accessible}
      accessibilityRole={onPress ? 'button' : undefined}
      aria-label={label}
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
            accessible={accessibility.hideTitle ? false : undefined}
            accessibilityElementsHidden={accessibility.hideTitle || undefined}
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
      {right ? null : trailIcon}
    </ActionRow>
  )
}

/**
 * 一行设置：左边名字，右边现在的值和朝右的箭头，点了出选择单。设置页上几项里选一项的都用它，
 * 读屏名称是“名字：值”
 */
export function ValueRow({
  title,
  value,
  onPress,
  testID,
}: {
  title: string
  value: string
  onPress(): void
  testID?: string
}) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  return (
    <Pressable
      accessibilityRole="button"
      aria-label={t('app.valued', { name: title, value })}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.valueRow,
        {
          minHeight: theme.hit,
          borderBottomColor: c.line1,
          backgroundColor: pressed ? c.press : c.panel,
        },
      ]}
    >
      <Text
        numberOfLines={1}
        style={[
          styles.valueTitle,
          { color: c.ink, fontSize: theme.font.size.body, fontFamily: theme.font.ui },
        ]}
      >
        {title}
      </Text>
      <Text numberOfLines={1} style={[styles.value, { color: c.ink2, fontFamily: theme.font.ui }]}>
        {value}
      </Text>
      <Icon name="forward" size={14} color={c.ink3} />
    </Pressable>
  )
}

/** 正在读、正在连这类等待：小转圈加一句短字，不另占一大块。外边距由调用方给 */
export function Loading({
  text,
  center,
  testID,
}: {
  text: string
  /** 居中（单独一块时）；缺省靠左跟着正文 */
  center?: boolean
  /** 挂在字上（原来这里就是一段字，测试按文字元素找它） */
  testID?: string
}) {
  const { c, font } = useTheme()
  return (
    <View style={[styles.loading, center ? styles.loadingCenter : null]}>
      <ActivityIndicator size="small" color={c.ink3} />
      <Text
        testID={testID}
        style={[styles.loadingText, { color: c.ink3, fontSize: font.size.meta }]}
      >
        {text}
      </Text>
    </View>
  )
}

/** 出错的横条：错误原文，行尾一个关闭图标（点了收起）。贴在页面顶上，红色下边线 */
export function ErrorBanner({
  text,
  onClose,
  testID,
}: {
  text: string
  onClose(): void
  testID?: string
}) {
  const t = useT()
  const { c, font } = useTheme()
  return (
    <View
      testID={testID}
      style={[styles.banner, { backgroundColor: c.sunken, borderBottomColor: c.err }]}
    >
      <Text style={[styles.bannerText, { color: c.err, fontSize: font.size.meta }]}>{text}</Text>
      <IconButton
        icon="close"
        label={t('app.dismiss')}
        color={c.err}
        onPress={onClose}
        testID={testID ? `${testID}:close` : undefined}
      />
    </View>
  )
}

/** 分组的小标题（复古皮肤里用等宽字） */
export function SectionLabel({ children, right }: { children: string; right?: ReactNode }) {
  const theme = useTheme()
  return (
    <View style={[styles.section, { backgroundColor: theme.c.win }]}>
      <Text style={[styles.sectionText, sectionFont(theme), { color: theme.c.ink2 }]}>
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
}: TextInputProps & { ref?: Ref<TextInput>; label: string; hint?: string; error?: string }) {
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
  busy,
}: {
  title: string
  detail?: string
  action?: ReactNode
  /** 在等（读取、连接）：标题上面一个转圈 */
  busy?: boolean
}) {
  const { c } = useTheme()
  return (
    <View style={styles.empty}>
      {busy ? <ActivityIndicator color={c.ink3} /> : null}
      <Text style={[styles.emptyTitle, { color: c.ink }]}>{title}</Text>
      {detail ? <Text style={[styles.emptyDetail, { color: c.ink2 }]}>{detail}</Text> : null}
      {action}
    </View>
  )
}

/** 可选的小块：一排里选一个或几个（日程种类、星期、新会话的 harness）。选中反白 */
export function Chip({
  label,
  on,
  onPress,
  onLongPress,
  disabled,
  dim,
  radio,
  accessibilityLabel,
  testID,
}: {
  label: string
  on?: boolean
  onPress?(): void
  onLongPress?(): void
  disabled?: boolean
  /** 画成不能用的样子，但还能点（点了说为什么不能用） */
  dim?: boolean
  /** 几个里只能选一个：读屏角色是 radio */
  radio?: boolean
  accessibilityLabel?: string
  testID?: string
}) {
  const { c, radius } = useTheme()
  return (
    <Pressable
      accessibilityRole={radio ? 'radio' : 'button'}
      accessibilityState={
        radio ? { checked: !!on, disabled: !!disabled } : { selected: !!on, disabled: !!disabled }
      }
      {...(accessibilityLabel ? { accessibilityLabel } : {})}
      disabled={disabled || !onPress}
      onPress={onPress}
      onLongPress={onLongPress}
      testID={testID}
      hitSlop={4}
      style={({ pressed }) => [
        styles.chip,
        {
          borderColor: on ? c.line3 : c.line2,
          borderRadius: radius.s,
          backgroundColor: on ? c.selBg : pressed ? c.press : 'transparent',
          opacity: disabled || dim ? 0.5 : 1,
        },
      ]}
    >
      <Text numberOfLines={1} style={[styles.chipText, { color: on ? c.selFg : c.ink }]}>
        {label}
      </Text>
    </Pressable>
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
  quiet: { paddingHorizontal: 10 },
  quietText: { fontWeight: '400' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowAction: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingRight: 16 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  rowTitle: { flex: 1, minWidth: 0, fontWeight: '500' },
  rowMeta: { fontSize: 11 },
  rowDetail: { fontSize: 13, marginTop: 2 },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  valueTitle: { flexShrink: 0, maxWidth: '60%' },
  value: { flex: 1, fontSize: 15, textAlign: 'right' },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
  loadingCenter: { justifyContent: 'center' },
  loadingText: { flexShrink: 1 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
    paddingRight: 4,
    borderBottomWidth: 2,
  },
  bannerText: { flex: 1, paddingVertical: 10 },
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
  fieldMulti: { minHeight: 120, maxHeight: 160, paddingVertical: 10, textAlignVertical: 'top' },
  fieldHint: { fontSize: 12 },
  empty: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  emptyTitle: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  emptyDetail: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  chip: { borderWidth: 1, paddingHorizontal: 10, minHeight: 34, justifyContent: 'center' },
  chipText: { fontSize: 14 },
})
