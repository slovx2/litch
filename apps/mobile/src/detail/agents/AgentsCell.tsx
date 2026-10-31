// 引擎自己启动的子代理（collab.spawnAgent）在对话里的那一行：照桌面端（packages/ui/src/tree/TreeCards.tsx 的 AgentsCard），
// 每个子代理一条小条：类型、一句话描述、用时、状态的字，点了进子代理页（AgentScreen.tsx）。不摊开任务说明。
// 等待、发输入这些别的协作调用还是过程组里的一步；子代理的状态以子线程为准（行里的 states，见 core/rows.ts）。
import {
  type AgentRunState,
  type AgentThreadView,
  type CoreChannel,
  firstSentence,
} from '@litch/core'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { memo, useEffect } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { duration, elapsed } from '../../../../../packages/ui/src/app/format.ts'
import type { RootStackParamList } from '../../nav/routes'
import { useChannel } from '../../shell/services'
import { type Translator, useT } from '../../ui/i18n'
import { type Palette, type Theme, useTheme } from '../../ui/theme'
import { type Props, useTicking } from '../cells'
import { useTranscript } from '../context'

/** 状态的字的颜色：进行中强调色，完成绿，失败红，排队和已停止淡色 */
export const stateColor = (state: AgentRunState, c: Palette): string =>
  state === 'running'
    ? c.accent
    : state === 'completed'
      ? c.ok
      : state === 'failed'
        ? c.err
        : c.ink3

/** 状态的字：复古皮肤写成方括号（[完成]），照桌面端 */
export const stateText = (state: AgentRunState, t: Translator, theme: Theme): string => {
  const text = t(`tree.agent.state.${state}`)
  return theme.skin === 'retro' ? `[${text}]` : text
}

/** 用了多久：做完的取子线程最近一个回合的用时，在跑的从开始的时候走表。说不出来的是 null */
export function useAgentTime(thread: AgentThreadView | undefined, t: Translator): string | null {
  const turn = thread?.turn
  const running = turn?.state === 'running' || thread?.status === 'running'
  const spent = useTicking(running ? (turn?.startedAt ?? null) : null)
  if (running) return spent === null ? null : elapsed(spent, t)
  return turn?.durationMs == null ? null : duration(turn.durationMs, t)
}

/** 子代理的描述：子线程上的，没有的取任务说明的第一句，再没有用昵称、“子代理 N” */
export const describe = (
  thread: AgentThreadView | undefined,
  fallback: string,
  index: number,
  t: Translator,
): string =>
  thread?.description ||
  firstSentence(fallback) ||
  thread?.nickname ||
  t('tree.agent.unnamed', { n: index + 1 })

/** 问过子代理列表的父会话：核心问一次就把列表交给开着的父会话，之后跟着子线程的回合推来 */
const asked = new Set<string>()

/** 列表里还没有条目里的子代理时问一次核心（照桌面端 useAgentList） */
function askAgents(channel: CoreChannel, deviceId: string, sessionId: string): void {
  const key = `${deviceId}\n${sessionId}`
  if (asked.has(key)) return
  asked.add(key)
  channel
    .command('session.agents', { deviceId, sessionId })
    // 问不到（没连着、对面不支持按父会话列）：照样能点，只是没有描述和用时
    .catch(() => asked.delete(key))
}

function AgentLine({
  parentId,
  threadId,
  thread,
  state,
  fallback,
  index,
}: {
  parentId: string
  threadId: string | null
  thread: AgentThreadView | undefined
  state: AgentRunState
  fallback: string
  index: number
}) {
  const theme = useTheme()
  const { c, font, radius } = theme
  const t = useT()
  const { deviceId } = useTranscript()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const time = useAgentTime(thread, t)
  const description = describe(thread, fallback, index, t)
  return (
    <Pressable
      disabled={!threadId}
      onPress={() =>
        threadId &&
        navigation.push('Agent', { deviceId, parentId, agentId: threadId, title: description })
      }
      accessibilityRole={threadId ? 'button' : undefined}
      accessibilityLabel={`${description} ${t(`tree.agent.state.${state}`)}`}
      style={({ pressed }) => [
        styles.line,
        {
          borderColor: c.line2,
          backgroundColor: pressed ? c.press : c.raised,
          borderRadius: radius.s,
        },
      ]}
      testID={threadId ? `agent:${threadId}` : 'agent:pending'}
    >
      <Text style={[styles.icon, { color: c.ink3, fontFamily: font.mono }]}>⑂</Text>
      {thread?.role ? (
        <Text style={[styles.kind, { color: c.ink3, fontFamily: font.mono }]} numberOfLines={1}>
          {thread.role}
        </Text>
      ) : null}
      <Text style={[styles.desc, { color: c.ink, fontFamily: font.ui }]} numberOfLines={1}>
        {description}
      </Text>
      {time ? (
        <Text style={[styles.time, { color: c.ink3, fontFamily: font.mono }]}>{time}</Text>
      ) : null}
      <Text
        style={[
          styles.state,
          { color: stateColor(state, c), fontFamily: theme.skin === 'retro' ? font.mono : font.ui },
        ]}
        testID="agent:state"
      >
        {stateText(state, t, theme)}
      </Text>
      {threadId ? <Text style={[styles.go, { color: c.ink3 }]}>›</Text> : null}
    </Pressable>
  )
}

const NO_STATES: AgentRunState[] = []

/** 启动子代理的那一次调用：每个子代理一条，并行派出的排在一起 */
export const AgentsCell = memo(function AgentsCell({ row }: Props<'agents'>) {
  const t = useT()
  const channel = useChannel()
  const { deviceId, sessionId } = useTranscript()
  const { item, threads } = row
  const agents = item.agents ?? []
  const states = row.states ? (row.states.split(' ') as AgentRunState[]) : NO_STATES
  const prompt =
    item.agentActivity?.name ||
    item.input.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n')
  const missing = agents.some((agent) => !threads.some((thread) => thread.id === agent.threadId))
  useEffect(() => {
    if (missing) askAgents(channel, deviceId, sessionId)
  }, [missing, channel, deviceId, sessionId])
  return (
    <View style={styles.rows} testID={`agents:${item.id}`}>
      {agents.length === 0 ? (
        // 刚开始派、还不知道是谁；或者没派出去
        <AgentLine
          parentId={sessionId}
          threadId={null}
          thread={undefined}
          state={item.status === 'failed' ? 'failed' : 'queued'}
          fallback={
            firstSentence(prompt) ||
            t(item.status === 'failed' ? 'tree.agent.spawnFailed' : 'tree.agent.spawning')
          }
          index={0}
        />
      ) : (
        agents.map((agent, index) => (
          <AgentLine
            key={agent.threadId}
            parentId={sessionId}
            threadId={agent.threadId}
            thread={threads.find((thread) => thread.id === agent.threadId)}
            state={states[index] ?? 'queued'}
            fallback={prompt}
            index={index}
          />
        ))
      )}
    </View>
  )
})

const styles = StyleSheet.create({
  rows: { paddingHorizontal: 16, paddingVertical: 4, gap: 4 },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 8,
    borderWidth: 1,
  },
  icon: { fontSize: 13 },
  kind: { fontSize: 11, maxWidth: 88 },
  desc: { flex: 1, fontSize: 13 },
  time: { fontSize: 11 },
  state: { fontSize: 11, fontWeight: '500' },
  go: { fontSize: 15, marginLeft: 2 },
})
