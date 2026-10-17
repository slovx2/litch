// 对话区的各种行。每个单元格按行对象 memo：行对象没换（rows.ts 的 keep）就不重画。
// 文字一律不可选：安卓上文本选择的监听在滚动时占主线程（调研报告 J8），原型先关掉，量过再说。
import { memo, useState } from 'react'
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native'
import { EnrichedMarkdownText } from 'react-native-enriched-markdown'
import type { Row, Step } from '../core/rows'
import { noteWork } from '../probe'
import { experiment } from '../experiment'
import { colors } from './theme'

type Props<T extends Row['type']> = { row: Extract<Row, { type: T }> }

export const UserCell = memo(function UserCell({ row }: Props<'user'>) {
  return (
    <View style={styles.userWrap}>
      <View style={styles.userBubble}>
        <Text style={styles.userText}>{row.text}</Text>
      </View>
    </View>
  )
})

const markdownStyle = {
  paragraph: { fontSize: 15, lineHeight: 22, color: colors.text },
  h2: { fontSize: 19, lineHeight: 26, color: colors.text, fontWeight: '700' as const },
  h3: { fontSize: 17, lineHeight: 24, color: colors.text, fontWeight: '700' as const },
  codeBlock: { fontSize: 13, lineHeight: 19, color: colors.text, backgroundColor: colors.code, padding: 10, borderRadius: 6 },
  code: { fontSize: 13, color: colors.text, backgroundColor: colors.code },
  blockquote: { borderColor: colors.border },
}

/**
 * 写完的块（不再长）第一次排好版后把高度钉死：宽高都定了，布局引擎就不再调它的测量函数。
 * 这个 Markdown 组件带表格时每次测量都整段重新解析、重新排版、不缓存，而它旁边的行一变，
 * 它所在的容器重新布局时就会被再测一遍。钉死以后，只有正在长的那一块在测量。
 */
export const MarkdownCell = memo(function MarkdownCell({ row }: Props<'md'>) {
  noteWork('mdCell', 0, row.text.length)
  const [frozen, setFrozen] = useState<number | null>(null)
  const freeze = row.open || frozen !== null ? undefined : (event: LayoutChangeEvent) => setFrozen(event.nativeEvent.layout.height)
  if (experiment.render === 'plain') {
    return (
      <View style={styles.md}>
        <Text style={markdownStyle.paragraph}>{row.text}</Text>
      </View>
    )
  }
  return (
    <View style={styles.md}>
      <EnrichedMarkdownText
        markdown={row.text}
        flavor="github"
        markdownStyle={markdownStyle}
        selectable={false}
        streamingConfig={streamingConfig}
        containerStyle={frozen === null || row.open ? undefined : { height: frozen }}
        onLayout={experiment.freeze ? freeze : undefined}
      />
    </View>
  )
})

const streamingConfig = { tableMode: 'progressive', codeBlockMode: 'progressive' } as const

export const ReasoningCell = memo(function ReasoningCell({ row }: Props<'reasoning'>) {
  return (
    <View style={styles.line}>
      <Text style={styles.muted} numberOfLines={1}>
        {row.open ? '思考中：' : '思考：'}
        {row.text}
      </Text>
    </View>
  )
})

function stepMark(step: Step): string {
  return step.state === 'running' ? '…' : step.state === 'failed' ? '✕' : '✓'
}

/**
 * 一组过程。收起时一行，高度固定；展开时列出每一步。
 * upward：展开的内容放在摘要上方。倒置列表里一行变高时是往上长的，这样被点的那一行原地不动，不用补偿滚动
 */
export const ProcessCell = memo(function ProcessCell({
  row,
  upward,
  onToggle,
}: Props<'process'> & { upward: boolean; onToggle(key: string): void }) {
  const last = row.steps[row.steps.length - 1]
  const summary = `${row.expanded ? '▾' : '▸'} ${row.steps.length} 个步骤${
    row.running && last ? ` · 正在运行：${last.label}` : ''
  }`
  const header = (
    <Pressable onPress={() => onToggle(row.key)} style={styles.processHeader} testID="process-toggle">
      <Text style={styles.processText} numberOfLines={1}>
        {summary}
      </Text>
    </Pressable>
  )
  if (!row.expanded) return <View style={styles.process}>{header}</View>
  const steps = (
    <View style={styles.steps}>
      {row.steps.map((step) => (
        <View key={step.id} style={styles.step}>
          <Text style={styles.stepText} numberOfLines={1}>
            {stepMark(step)} {step.label}
          </Text>
          {step.detail ? (
            <Text style={styles.stepDetail} numberOfLines={6}>
              {step.detail}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  )
  return (
    <View style={styles.process}>
      {upward ? steps : null}
      {header}
      {upward ? null : steps}
    </View>
  )
})

function statusText(row: Extract<Row, { type: 'status' }>): string {
  const seconds = row.durationMs == null ? '' : ` · ${(row.durationMs / 1000).toFixed(1)} 秒`
  switch (row.status) {
    case 'running':
      return '运行中…'
    case 'completed':
      return `完成${seconds}`
    case 'interrupted':
      return `已打断${seconds}`
    default:
      return `失败${row.error ? `：${row.error}` : ''}`
  }
}

/** 回合末尾的状态行：从回合开始一直在，高度固定，只换字 */
export const StatusCell = memo(function StatusCell({ row }: Props<'status'>) {
  return (
    <View style={styles.status}>
      <Text style={styles.statusText} numberOfLines={1}>
        {statusText(row)}
      </Text>
    </View>
  )
})

const styles = StyleSheet.create({
  userWrap: { paddingHorizontal: 16, paddingVertical: 6, alignItems: 'flex-end' },
  userBubble: { backgroundColor: colors.bubble, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, maxWidth: '85%' },
  userText: { fontSize: 15, lineHeight: 22, color: colors.text },
  md: { paddingHorizontal: 16, paddingVertical: 4 },
  line: { paddingHorizontal: 16, height: 28, justifyContent: 'center' },
  muted: { fontSize: 13, color: colors.muted },
  process: { paddingHorizontal: 16, paddingVertical: 2 },
  processHeader: { height: 32, justifyContent: 'center' },
  processText: { fontSize: 13, color: colors.muted },
  steps: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: 10, marginVertical: 4 },
  step: { paddingVertical: 3 },
  stepText: { fontSize: 13, color: colors.text, fontFamily: 'monospace' },
  stepDetail: { fontSize: 12, color: colors.muted, fontFamily: 'monospace' },
  status: { paddingHorizontal: 16, height: 26, justifyContent: 'center' },
  statusText: { fontSize: 12, color: colors.muted },
})
