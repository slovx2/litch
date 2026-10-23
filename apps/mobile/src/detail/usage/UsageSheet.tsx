// 用量页：从底部弹出，上下文用了多少、账号的订阅额度（Claude Code 的 Anthropic 订阅、Codex 的 ChatGPT 登录才有）
// 各用了多少、多久后重置，下面一个“压缩上下文”。点输入区下面的“上下文 N%”或会话菜单里的“用量与额度”打开。
// 照桌面端用量环的弹层（packages/ui/src/composer/ContextMeter.tsx）：开着才订阅额度（accountLimits 主题），
// 核心那时才去读（Claude Code 每读一次要起一个 CLI，两次之间至少隔 30 秒），之后跟着更新通知走。
import type { AccountLimitRow, AccountLimitsOp, ContextUsage } from '@litch/core'
import { useEffect, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useNow } from '../../screens/sessions/clock'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'
import { contextLine, limitLines, type UsageLine, usageLevel } from './logic'

/** 读额度最多等多久（核心那头是 25 秒）：过了还没有就当这个账号没有额度 */
const READ_WAIT_MS = 25_000

/** 订阅一个 harness 的账号额度；reading 是还在等第一次读的结果 */
function useLimits(deviceId: string, harness: string | undefined, open: boolean) {
  const channel = useChannel()
  const [rows, setRows] = useState<AccountLimitRow[]>([])
  const [waiting, setWaiting] = useState(false)
  useEffect(() => {
    if (!open || !harness) return
    setWaiting(true)
    const timer = setTimeout(() => setWaiting(false), READ_WAIT_MS)
    const stop = channel.subscribe(
      { kind: 'accountLimits', deviceId, harness },
      {
        // 上次读到的先给出来：有就不用说在读
        snapshot: (data) => {
          setRows(data.rows)
          if (data.rows.length > 0) setWaiting(false)
        },
        delta: (ops: AccountLimitsOp[]) => {
          const last = ops.at(-1)
          if (!last) return
          setRows(last.view.rows)
          setWaiting(false)
        },
        // 订不上就当没有额度
        error: () => {
          setRows([])
          setWaiting(false)
        },
      },
    )
    return () => {
      clearTimeout(timer)
      stop()
    }
  }, [channel, deviceId, harness, open])
  return { rows, reading: waiting && rows.length === 0 }
}

export interface CompactEntry {
  /** 现在压不了的原因（回合在跑）；能压是 null */
  blocked: string | null
  run(): void
}

export function UsageSheet({
  visible,
  deviceId,
  harness,
  usage,
  compact,
  onClose,
}: {
  visible: boolean
  deviceId: string
  harness: string | undefined
  usage: ContextUsage | null | undefined
  /** harness 不会压缩时不给，按钮不出 */
  compact: CompactEntry | null
  onClose(): void
}) {
  const insets = useSafeAreaInsets()
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  const now = useNow()
  const { rows, reading } = useLimits(deviceId, harness, visible)
  const limits = limitLines(rows, now, t)
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} testID="usage:scrim" />
      <View
        testID="usage:sheet"
        style={[
          styles.sheet,
          {
            backgroundColor: c.raised,
            borderColor: c.line3,
            borderTopLeftRadius: theme.radius.l,
            borderTopRightRadius: theme.radius.l,
            paddingBottom: insets.bottom + 12,
          },
        ]}
      >
        <Text style={[styles.title, { color: c.ink2, fontFamily: theme.font.mono }]}>
          {t('usage.title')}
        </Text>
        <ScrollView style={styles.list}>
          <Line line={contextLine(usage, t)} testID="usage:context" />
          <Text style={[styles.group, { color: c.ink3 }]}>{t('usage.limits')}</Text>
          {limits.length > 0 ? (
            limits.map((line) => <Line key={line.id} line={line} testID="usage:limit" />)
          ) : (
            <Text style={[styles.empty, { color: c.ink3 }]} testID="usage:noLimits">
              {t(reading ? 'usage.reading' : 'usage.noLimits')}
            </Text>
          )}
        </ScrollView>
        {compact ? (
          <View style={styles.compact}>
            <Button
              kind="plain"
              label={t('context.compact')}
              disabled={compact.blocked !== null}
              testID="usage:compact"
              onPress={() => {
                onClose()
                compact.run()
              }}
            />
            {compact.blocked ? (
              <Text style={[styles.why, { color: c.ink3 }]}>{compact.blocked}</Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </Modal>
  )
}

/** 一行：名字靠左，补充的那句和百分比靠右，下面一条细进度条；快用完换提醒的颜色 */
function Line({ line, testID }: { line: UsageLine; testID: string }) {
  const theme = useTheme()
  const { c } = theme
  const level = usageLevel(line.percent)
  const tone = level === 'full' ? c.err : level === 'high' ? c.wait : c.accent
  const width = line.percent === null ? 0 : Math.min(100, line.percent)
  return (
    <View style={styles.line} testID={testID}>
      <View style={styles.head}>
        <Text numberOfLines={1} style={[styles.name, { color: c.ink }]}>
          {line.label}
        </Text>
        {line.detail ? (
          <Text numberOfLines={1} style={[styles.detail, { color: c.ink3 }]}>
            {line.detail}
          </Text>
        ) : null}
        <Text style={[styles.percent, { color: c.ink2, fontFamily: theme.font.mono }]}>
          {line.percent === null ? '—' : `${line.percent}%`}
        </Text>
      </View>
      <View style={[styles.track, { backgroundColor: c.press, borderRadius: theme.radius.s }]}>
        <View
          style={[
            styles.fill,
            { width: `${width}%`, backgroundColor: tone, borderRadius: theme.radius.s },
          ]}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { borderTopWidth: 1, maxHeight: '70%' },
  title: { fontSize: 12, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  list: { flexGrow: 0 },
  group: { fontSize: 12, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 2 },
  empty: { fontSize: 13, paddingHorizontal: 16, paddingVertical: 8 },
  line: { paddingHorizontal: 16, paddingVertical: 8, gap: 6 },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  name: { flexShrink: 1, fontSize: 14 },
  detail: { flex: 1, fontSize: 12, textAlign: 'right' },
  percent: { fontSize: 13, minWidth: 40, textAlign: 'right' },
  track: { height: 4, overflow: 'hidden' },
  fill: { height: 4 },
  compact: { paddingHorizontal: 16, paddingTop: 10, gap: 4, alignItems: 'flex-start' },
  why: { fontSize: 12 },
})
