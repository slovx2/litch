// 终端下面的输入条：手机键盘上没有、终端里又常用的键。贴在键盘上面（键盘收起时贴在屏幕底）。
// 最左边是键盘键（弹出、收起键盘），接着是 Esc、Tab、Ctrl（按一下亮起，下一个字带上 Ctrl，用掉就灭）、
// 方向键（按住连发），后面是一排常用符号，横着滑。键的字是通用的键名和符号，不用翻译。
import { useEffect, useRef } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useT } from '../../../ui/i18n'
import { useTheme } from '../../../ui/theme'

type Key =
  | { kind: 'key'; label: string; k: string; repeat?: boolean }
  | { kind: 'text'; label: string; d: string }

const KEYS: Key[] = [
  { kind: 'key', label: 'Esc', k: 'esc' },
  { kind: 'key', label: 'Tab', k: 'tab' },
]
const ARROWS: Key[] = [
  { kind: 'key', label: '←', k: 'left', repeat: true },
  { kind: 'key', label: '↑', k: 'up', repeat: true },
  { kind: 'key', label: '↓', k: 'down', repeat: true },
  { kind: 'key', label: '→', k: 'right', repeat: true },
]
const MORE: Key[] = [
  { kind: 'text', label: '^C', d: '\u0003' },
  ...['|', '-', '/', '~', '_', ':', ';', '*', '&', '$', '"', "'", '`', '<', '>'].map(
    (d): Key => ({ kind: 'text', label: d, d }),
  ),
  ...['[', ']', '{', '}', '(', ')', '=', '\\', '!', '#', '%', '^', '@', '?', '+'].map(
    (d): Key => ({ kind: 'text', label: d, d }),
  ),
  { kind: 'key', label: 'Home', k: 'home' },
  { kind: 'key', label: 'End', k: 'end' },
  { kind: 'key', label: 'PgUp', k: 'pgup' },
  { kind: 'key', label: 'PgDn', k: 'pgdn' },
]

const REPEAT_AFTER_MS = 400
const REPEAT_EVERY_MS = 60

export function KeyBar({
  ctrl,
  keyboard,
  disabled,
  bottom,
  onKey,
  onText,
  onCtrl,
  onKeyboard,
}: {
  /** Ctrl 亮着 */
  ctrl: boolean
  /** 键盘焦点在终端上 */
  keyboard: boolean
  /** 终端不在运行：键都灰掉 */
  disabled: boolean
  /** 底下垫多少（键盘收起时是安全区） */
  bottom: number
  onKey(k: string): void
  onText(d: string): void
  onCtrl(): void
  onKeyboard(): void
}) {
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  const send = (key: Key) => (key.kind === 'key' ? onKey(key.k) : onText(key.d))
  return (
    <View
      style={[
        styles.bar,
        { backgroundColor: c.panel, borderTopColor: c.line2, paddingBottom: bottom },
      ]}
    >
      <Cap
        label="⌨"
        on={keyboard}
        accessibilityLabel={t(keyboard ? 'tools.term.hideKeyboard' : 'tools.term.showKeyboard')}
        testID="terminal:key:keyboard"
        onPress={onKeyboard}
      />
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {KEYS.map((key) => (
          <Cap key={key.label} label={key.label} disabled={disabled} onPress={() => send(key)} />
        ))}
        <Cap
          label="Ctrl"
          on={ctrl}
          disabled={disabled}
          testID="terminal:key:ctrl"
          onPress={onCtrl}
        />
        {ARROWS.map((key) => (
          <Cap
            key={key.label}
            label={key.label}
            disabled={disabled}
            repeat
            onPress={() => send(key)}
          />
        ))}
        {MORE.map((key) => (
          <Cap key={key.label} label={key.label} disabled={disabled} onPress={() => send(key)} />
        ))}
      </ScrollView>
    </View>
  )
}

function Cap({
  label,
  on,
  disabled,
  repeat,
  accessibilityLabel,
  testID,
  onPress,
}: {
  label: string
  on?: boolean
  disabled?: boolean
  /** 按住连发 */
  repeat?: boolean
  accessibilityLabel?: string
  testID?: string
  onPress(): void
}) {
  const theme = useTheme()
  const { c } = theme
  const timers = useRef<{
    wait: ReturnType<typeof setTimeout> | null
    every: ReturnType<typeof setInterval> | null
  }>({
    wait: null,
    every: null,
  })
  const stop = () => {
    if (timers.current.wait) clearTimeout(timers.current.wait)
    if (timers.current.every) clearInterval(timers.current.every)
    timers.current = { wait: null, every: null }
  }
  // 按住的时候页面没了：连发要停
  useEffect(
    () => () => {
      if (timers.current.wait) clearTimeout(timers.current.wait)
      if (timers.current.every) clearInterval(timers.current.every)
    },
    [],
  )
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled, selected: !!on }}
      testID={testID ?? `terminal:key:${label}`}
      disabled={disabled}
      // 平常的键松手才算（横着滑这一排时不误按）；连发的键一按下就发，按住了接着发
      onPress={repeat ? undefined : onPress}
      onPressIn={
        repeat
          ? () => {
              onPress()
              timers.current.wait = setTimeout(() => {
                timers.current.every = setInterval(onPress, REPEAT_EVERY_MS)
              }, REPEAT_AFTER_MS)
            }
          : undefined
      }
      onPressOut={repeat ? stop : undefined}
      style={({ pressed }) => [
        styles.cap,
        {
          minHeight: theme.hit - 6,
          borderColor: c.line2,
          borderRadius: theme.radius.m,
          backgroundColor: on ? c.selBg : pressed ? c.press : c.raised,
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.capText,
          {
            color: on ? c.selFg : c.ink,
            fontFamily: theme.font.mono,
            fontSize: theme.font.size.meta,
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingLeft: 4,
    paddingTop: 4,
  },
  row: { gap: 4, paddingHorizontal: 4, paddingBottom: 4, alignItems: 'center' },
  cap: {
    minWidth: 40,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    marginBottom: 4,
  },
  capText: { fontWeight: '600' },
})
