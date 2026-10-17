// 请求卡片共用的部分：答复（session.respond，发出去到卡片消失之间不能再点第二次）、卡片的外框、
// 底下那一行（没答复成的原因、后面还排着几个）。卡片排在输入区上面，最高到 maxHeight：
// 内容多的在里面自己滚，底下那排按钮一直贴着底，输入区不被挤走（和桌面端 Dock 的规矩一样）。
import type { RequestView } from '@litch/core'
import { createContext, type ReactNode, useContext, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'

export interface CardProps<R extends RequestView = RequestView> {
  deviceId: string
  sessionId: string
  request: R
  /** 这个请求后面还排着几个 */
  waiting: number
}

export interface Choice {
  optionId?: string
  /** 附在决定上的一句说明 */
  note?: string
  answers?: Record<string, string[]>
  values?: Record<string, unknown>
}

/** 卡片最高多少（外面按屏幕和键盘算好给进来） */
export const CardHeight = createContext(320)

export function useRespond({ deviceId, sessionId, request }: CardProps) {
  const channel = useChannel()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 发出去了还没有结果。busy 要等重画才变，这里当场就记下：定时前进和手指挤在一起也只发一次 */
  const sending = useRef(false)
  const respond = (choice: Choice) => {
    if (sending.current) return
    sending.current = true
    setBusy(true)
    setError(null)
    channel
      .command('session.respond', { deviceId, sessionId, requestId: request.id, ...choice })
      .catch((failure: unknown) => {
        // 成功的话卡片会随着请求一起消失，不用把 busy 放开
        sending.current = false
        setBusy(false)
        setError(t('request.failed', { reason: whyNot(failure, t) }))
      })
  }
  return { busy, error, setError, respond }
}

export function Card({
  title,
  right,
  children,
  actions,
  waiting,
  error,
  testID,
}: {
  title: string
  /** 标题行右边的小字（第几题共几题） */
  right?: string
  children: ReactNode
  /** 底下那排按钮 */
  actions: ReactNode
  waiting: number
  error: string | null
  testID: string
}) {
  const theme = useTheme()
  const t = useT()
  const maxHeight = useContext(CardHeight)
  const { c } = theme
  return (
    <View
      testID={testID}
      style={[styles.card, { maxHeight, backgroundColor: c.raised, borderColor: c.wait }]}
    >
      <View style={[styles.head, { borderBottomColor: c.line1 }]}>
        <Text style={[styles.mark, { color: c.wait }]}>◆</Text>
        <Text numberOfLines={2} style={[styles.title, { color: c.ink }]}>
          {title}
        </Text>
        {right ? (
          <Text style={[styles.right, { color: c.ink3, fontFamily: theme.font.mono }]}>
            {right}
          </Text>
        ) : null}
      </View>
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyIn}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        {children}
      </ScrollView>
      <View style={[styles.actions, { borderTopColor: c.line1 }]}>{actions}</View>
      {error || waiting > 0 ? (
        <View style={styles.foot}>
          {error ? (
            <Text testID={`${testID}:error`} style={[styles.footText, { color: c.err }]}>
              {error}
            </Text>
          ) : null}
          {waiting > 0 ? (
            <Text style={[styles.footText, { color: c.ink3 }]}>
              {t('request.more', { count: waiting })}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

/** 卡片上的按钮。primary 实心（主要动作），danger 红框（拒绝并停下），别的只有边框 */
export function CardButton({
  label,
  onPress,
  kind = 'plain',
  disabled,
  testID,
}: {
  label: string
  onPress(): void
  kind?: 'primary' | 'plain' | 'danger' | 'ghost'
  disabled?: boolean
  testID?: string
}) {
  const theme = useTheme()
  const { c } = theme
  const bg = kind === 'primary' ? c.accentSolid : 'transparent'
  const fg =
    kind === 'primary' ? c.onAccent : kind === 'danger' ? c.err : kind === 'ghost' ? c.ink2 : c.ink
  const border = kind === 'danger' ? c.err : kind === 'ghost' ? c.line1 : c.line3
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: theme.hit - 4,
          backgroundColor: bg,
          borderColor: border,
          opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
        },
      ]}
    >
      <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
    </Pressable>
  )
}

/** 卡片里一段等宽的原文：命令、参数、网址。折行显示，长的随卡片一起滚 */
export function Well({ children }: { children: string }) {
  const theme = useTheme()
  return (
    <View style={[styles.well, { backgroundColor: theme.c.sunken, borderColor: theme.c.line1 }]}>
      <Text
        selectable
        style={[styles.wellText, { color: theme.c.ink, fontFamily: theme.font.mono }]}
      >
        {children}
      </Text>
    </View>
  )
}

/** 一行“名目：值” */
export function Meta({ label, value }: { label: string; value: string }) {
  const theme = useTheme()
  return (
    <Text style={[styles.meta, { color: theme.c.ink2 }]}>
      {label} <Text style={{ color: theme.c.ink, fontFamily: theme.font.mono }}>{value}</Text>
    </Text>
  )
}

export function Why({ children, tone }: { children: string; tone?: 'err' }) {
  const { c } = useTheme()
  return <Text style={[styles.why, { color: tone === 'err' ? c.err : c.ink2 }]}>{children}</Text>
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 8, marginBottom: 6, borderWidth: 1, borderLeftWidth: 3 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  mark: { fontSize: 12 },
  title: { flex: 1, fontSize: 14, fontWeight: '600' },
  right: { fontSize: 11 },
  body: { flexGrow: 0, flexShrink: 1 },
  bodyIn: { paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  foot: { paddingHorizontal: 12, paddingBottom: 8, gap: 2 },
  footText: { fontSize: 12 },
  button: {
    paddingHorizontal: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 14, fontWeight: '600' },
  well: { borderWidth: 1 },
  wellText: { fontSize: 12, lineHeight: 17, padding: 8 },
  meta: { fontSize: 13 },
  why: { fontSize: 13, lineHeight: 19 },
})
