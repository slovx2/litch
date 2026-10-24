// 一个会话的后台任务（桌面右侧“后台任务”页的简化版）：后台命令、引擎自己派出的子代理、会话树里的子会话合在一张，
// 运行中在上（先开始的在前）、已结束在下（刚结束的在前），每行类型、名称、用时、状态。
// 点子代理、子会话进它的详情页（子代理的对话照核心的规矩，能不能直接说话由核心定）；命令不展开输出。
// 在跑的命令和监视、harness 会单独停的子代理、在跑的子会话给“停止”。
// 从输入框上方那一行或者会话详情右上角菜单里的“后台任务”进来。
import {
  type BackgroundEntryView,
  type BackgroundTaskKind,
  type DeviceView,
  keys,
  type SessionSummary,
} from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import { duration } from '../../../../../packages/ui/src/app/format.ts'
import { useBackgroundEntries } from '../../detail/background/state'
import { useSessionStore } from '../../detail/proposals/hooks'
import type { RootStackParamList } from '../../nav/routes'
import { useChannel, useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Empty, SectionLabel } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Background'>

/** 能从这里停的后台命令：经协议的后台终端停（session.stopBackground） */
const STOPPABLE_TASKS: ReadonlySet<BackgroundTaskKind> = new Set(['shell', 'monitor'])

/** 这一行有没有“停止”：在跑的命令和监视、harness 会单独停的子代理、在跑的子会话 */
function stoppable(entry: BackgroundEntryView, stopsAgents: boolean): boolean {
  if (entry.status !== 'running') return false
  if (entry.source === 'task') return STOPPABLE_TASKS.has(entry.kind)
  if (entry.source === 'agent') return stopsAgents
  return true
}

export function BackgroundScreen({ route, navigation }: Props) {
  const { deviceId, sessionId } = route.params
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const device = useKey<DeviceView>(keys.device(deviceId))
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const store = useSessionStore(deviceId, sessionId)
  const view = useBackgroundEntries(store)
  const [failure, setFailure] = useState<string | null>(null)
  const entries = view?.entries ?? []
  const running = entries.filter((entry) => entry.status === 'running')
  const ended = entries.filter((entry) => entry.status !== 'running')
  const stopsAgents =
    device?.harnesses.find((entry) => entry.id === summary?.harness)?.abilities?.stopAgent === true
  // 在跑的用时一秒一秒地走：有在跑的才走
  const [now, setNow] = useState(Date.now())
  const ticking = running.length > 0
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  // 后台命令跑完的“会不会自动接着做”只说命令：没有在跑的命令就不说
  const tasksRunning = running.some((entry) => entry.source === 'task')
  const wakes = tasksRunning ? (view?.wakesOnFinish ?? null) : null
  const title =
    route.params.title ?? (typeof summary?.title === 'string' ? summary.title : undefined)
  const row = (entry: BackgroundEntryView) => (
    <EntryRow
      key={entry.key}
      deviceId={deviceId}
      sessionId={sessionId}
      entry={entry}
      now={now}
      canStop={stoppable(entry, stopsAgents)}
      onFail={setFailure}
      onOpen={
        entry.source === 'task'
          ? null
          : () => navigation.push('Detail', { deviceId, sessionId: entry.id, title: entry.title })
      }
    />
  )
  return (
    <Screen
      title={t('side.tab.background')}
      subtitle={title}
      wire={device ? c.wire[device.wire] : undefined}
      testID="background"
    >
      {failure ? (
        <Text style={[styles.failure, { color: c.err }]} testID="background:failure">
          {failure}
        </Text>
      ) : null}
      {entries.length === 0 ? (
        <Empty title={t('background.noneEver')} />
      ) : (
        <ScrollView>
          <View testID="background:running">
            <SectionLabel
              right={
                wakes === null ? undefined : (
                  <Text numberOfLines={1} style={[styles.note, { color: c.ink3 }]}>
                    {t(wakes ? 'background.wakes' : 'background.noWake')}
                  </Text>
                )
              }
            >
              {`${t('background.running')} ${running.length}`}
            </SectionLabel>
          </View>
          {running.length > 0 ? (
            running.map(row)
          ) : (
            <Text style={[styles.none, { color: c.ink3 }]}>{t('background.none')}</Text>
          )}
          {ended.length > 0 ? (
            <>
              <View testID="background:ended">
                <SectionLabel>{`${t('background.ended')} ${ended.length}`}</SectionLabel>
              </View>
              {ended.map(row)}
            </>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  )
}

function EntryRow({
  deviceId,
  sessionId,
  entry,
  now,
  canStop,
  onFail,
  onOpen,
}: {
  deviceId: string
  sessionId: string
  entry: BackgroundEntryView
  now: number
  canStop: boolean
  onFail(message: string | null): void
  /** 点这一行进它的详情页；命令是 null */
  onOpen: (() => void) | null
}) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const channel = useChannel()
  const [stopping, setStopping] = useState(false)
  const elapsed = entry.startedAt === null ? null : (entry.endedAt ?? now) - entry.startedAt
  const color =
    entry.status === 'running'
      ? c.accent
      : entry.status === 'failed'
        ? c.err
        : entry.status === 'completed'
          ? c.ok
          : c.ink3
  const kind = entry.source === 'child' ? 'child' : entry.kind
  const stop = () => {
    setStopping(true)
    onFail(null)
    const done =
      entry.source === 'task'
        ? channel.command('session.stopBackground', {
            deviceId,
            sessionId,
            taskId: entry.id,
            itemId: entry.task?.itemId ?? null,
          })
        : channel.command('session.interrupt', { deviceId, sessionId: entry.id })
    done.catch((error: unknown) => onFail(whyNot(error, t))).finally(() => setStopping(false))
  }
  return (
    <Pressable
      accessibilityRole={onOpen ? 'button' : undefined}
      disabled={!onOpen}
      onPress={onOpen ?? undefined}
      style={({ pressed }) => [
        styles.row,
        { borderTopColor: c.line1, backgroundColor: pressed ? c.line1 : undefined },
      ]}
      testID={`background:entry:${entry.source}:${entry.status}`}
    >
      <View style={styles.main}>
        <Text
          numberOfLines={1}
          style={[styles.rowTitle, { color: c.ink2, fontFamily: theme.font.mono }]}
        >
          {entry.title || t(`background.kind.${kind}`)}
        </Text>
        <Text numberOfLines={1} style={[styles.meta, { color: c.ink3 }]}>
          {t(`background.kind.${kind}`)}
          {elapsed === null ? '' : ` · ${duration(Math.max(0, elapsed), t)}`}
        </Text>
      </View>
      <Text style={[styles.meta, { color, fontFamily: theme.font.mono }]}>
        {t(`background.status.${entry.status}`)}
      </Text>
      {canStop ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('background.stop.title')}
          disabled={stopping}
          onPress={stop}
          hitSlop={6}
          style={[styles.stop, { borderColor: c.line3, borderRadius: theme.radius.s }]}
          testID={`background:stop:${entry.source}`}
        >
          <Text style={[styles.stopText, { color: stopping ? c.ink3 : c.err }]}>
            {t(stopping ? 'background.stopping' : 'background.stop')}
          </Text>
        </Pressable>
      ) : null}
      {onOpen ? <Text style={{ color: c.ink3 }}>›</Text> : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  failure: { fontSize: 13, paddingHorizontal: 16, paddingVertical: 8 },
  note: { fontSize: 12, maxWidth: 200 },
  none: { fontSize: 13, paddingHorizontal: 16, paddingVertical: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  main: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { fontSize: 13 },
  meta: { fontSize: 12 },
  stop: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 4 },
  stopText: { fontSize: 12, fontWeight: '500' },
})
