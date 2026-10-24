// 子代理页：对话里子代理那一行点进来。照桌面端侧面板的“子代理”页（packages/ui/src/tree/AgentsTab.tsx）：
// 上面是描述、状态的字、类型、名称、用时，分派的任务（长的先露几行）、失败的原因；下面是子线程自己的对话，
// 和会话详情同一套对话区。只看不发：子代理的输入归派出它的会话管。
// 子代理的状态、描述从父会话的存储里取（会话上的子代理列表，核心跟着子线程的回合推来），子线程的对话另开一份存储。
import { type AgentThreadView, agentRunState } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { acquireStore, releaseStore } from '../../core/store-cache'
import { experiment } from '../../experiment'
import type { RootStackParamList } from '../../nav/routes'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { Transcript } from '../Transcript'
import { stateColor, stateText, useAgentTime } from './AgentsCell'

type Props = NativeStackScreenProps<RootStackParamList, 'Agent'>

/** 任务说明先露几行，长的给“展开全部” */
const TASK_LINES = 3
const TASK_CHARS = 160

const NO_AGENTS: AgentThreadView[] = []

export function AgentScreen({ route }: Props) {
  const { deviceId, parentId, agentId, title } = route.params
  const channel = useChannel()
  const t = useT()
  const theme = useTheme()
  const { c, font, radius } = theme
  const insets = useSafeAreaInsets()
  const parent = useMemo(
    () => acquireStore(channel, deviceId, parentId),
    [channel, deviceId, parentId],
  )
  useEffect(() => () => releaseStore(parent), [parent])
  const store = useMemo(
    () => acquireStore(channel, deviceId, agentId),
    [channel, deviceId, agentId],
  )
  useEffect(() => () => releaseStore(store), [store])
  const agents = useSyncExternalStore(
    parent.subscribeMeta,
    () => parent.getMeta()?.agents ?? NO_AGENTS,
  )
  const agent = agents.find((entry) => entry.id === agentId)
  // 列表里还没有它（刚派出、设备还没列过）时不写状态，不猜
  const state = agent ? agentRunState(agent, null, null) : null
  const time = useAgentTime(agent, t)
  const [open, setOpen] = useState(false)
  const prompt = agent?.prompt ?? ''
  const long = prompt.split('\n').length > TASK_LINES || Array.from(prompt).length > TASK_CHARS
  const failure = state === 'failed' ? (agent?.turn?.error ?? null) : null
  const shownTitle =
    agent?.description || agent?.nickname || title || t('tree.agent.unnamed', { n: 1 })
  const meta = [
    agent?.role ? `${t('agents.meta.kind')} ${agent.role}` : null,
    agent?.nickname ? `${t('agents.meta.name')} ${agent.nickname}` : null,
    time ? `${t('agents.meta.time')} ${time}` : null,
  ].filter(Boolean)
  return (
    <Screen title={shownTitle} testID="agent">
      <View
        style={[styles.head, { borderBottomColor: c.line1, backgroundColor: c.panel }]}
        testID="agent:head"
      >
        <View style={styles.line}>
          {state ? (
            <Text
              style={[
                styles.state,
                {
                  color: stateColor(state, c),
                  fontFamily: theme.skin === 'retro' ? font.mono : font.ui,
                },
              ]}
              testID="agent:state"
            >
              {stateText(state, t, theme)}
            </Text>
          ) : null}
          {meta.length > 0 ? (
            <Text style={[styles.meta, { color: c.ink3, fontFamily: font.mono }]} numberOfLines={1}>
              {meta.join(' · ')}
            </Text>
          ) : null}
        </View>
        {prompt ? (
          <View
            style={[
              styles.task,
              { borderColor: c.line1, backgroundColor: c.sunken, borderRadius: radius.m },
            ]}
          >
            <Text style={[styles.label, { color: c.ink3 }]}>{t('agents.task')}</Text>
            <Text
              style={[styles.taskText, { color: c.ink2 }]}
              numberOfLines={open ? undefined : TASK_LINES}
              testID="agent:task"
            >
              {prompt}
            </Text>
            {long ? (
              <Pressable onPress={() => setOpen(!open)} hitSlop={8} accessibilityRole="button">
                <Text style={[styles.more, { color: c.accent }]}>
                  {t(open ? 'agents.task.less' : 'agents.task.more')}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {state === 'failed' ? (
          <View
            style={[styles.fail, { borderColor: c.err, borderRadius: radius.m }]}
            accessibilityRole="alert"
            testID="agent:failure"
          >
            <Text style={[styles.failHead, { color: c.err }]}>
              {t(agent?.turn ? 'agents.fail.run' : 'agents.fail.start')}
            </Text>
            <Text style={[styles.taskText, { color: c.ink2 }]}>
              {failure ?? t('agents.fail.unknown')}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={styles.list}>
        <Transcript store={store} bottomOffset={insets.bottom} markers={experiment.markers} />
      </View>
      <View style={{ height: insets.bottom, backgroundColor: c.panel }} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: 16, paddingVertical: 10, gap: 8, borderBottomWidth: 1 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  state: { fontSize: 13, fontWeight: '600' },
  meta: { flex: 1, fontSize: 11 },
  task: { borderWidth: 1, padding: 10, gap: 4 },
  label: { fontSize: 11 },
  taskText: { fontSize: 13, lineHeight: 19 },
  more: { fontSize: 12, marginTop: 2 },
  fail: { borderWidth: 1, padding: 10, gap: 4 },
  failHead: { fontSize: 13, fontWeight: '600' },
  list: { flex: 1 },
})
