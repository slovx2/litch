// 过程：一组的摘要（收起时一行，高度固定）和展开后的每一步。每一步一行，点开看细节：
// 命令的输出末尾、改了哪些文件和一小段差异、工具调用的参数和结果。细节都有上限，长的到“差异”“文件”页去看。
import { diffLines, knownFileRef, type ToolPart, taskOfItem } from '@litch/core'
import { Children, memo, type ReactNode } from 'react'
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { Row, StepState } from '../core/rows'
import { type Translator, useT } from '../ui/i18n'
import { type Palette, useTheme } from '../ui/theme'
import { styles as cellStyles, type Props, seconds } from './cells'
import { useBackgroundView, useTranscript } from './context'
import { fileHref, isWebUrl } from './links'

/** 命令的输出最多露出末尾多少行 */
const OUTPUT_LINES = 40
/** 一次改动的差异最多露出多少行（几个文件合起来） */
const DIFF_LINES = 60
/** 工具调用的参数、结果，每一样最多露出多少个字 */
const TOOL_CHARS = 1500
/** 工具结果最多露出几段（文字、图片各算一段），其中最多几张缩略图：几千张小图的结果也只占一小截 */
const TOOL_PARTS = 16
const TOOL_SHOTS = 3

const MARK: Record<StepState, string> = { running: '…', done: '✓', failed: '✕', declined: '⊘' }

/** 一组过程的摘要。点了展开收起；展开的步骤在它上面，它自己原地不动 */
export const GroupCell = memo(function GroupCell({ row }: Props<'group'>) {
  const { c, font } = useTheme()
  const t = useT()
  const { toggle } = useTranscript()
  const background = useBackgroundView()
  // 回合结束了还在跑的步骤是后台任务：摘要末尾写还有几个在后台运行（照桌面端收起行的记号）
  const inBackground =
    row.ended && background && background.running > 0
      ? row.ids.split(' ').filter((id) => taskOfItem(background, id)?.status === 'running').length
      : 0
  const steps = t('activity.steps', { n: row.count })
  const tail = row.current
    ? ` · ${t('detail.group.running', { label: t.text(row.current) })}`
    : row.failed > 0
      ? ` · ${t('detail.group.failed', { n: row.failed })}`
      : ''
  return (
    <View style={styles.group}>
      <Pressable
        onPress={() => toggle(row.key, row.turnId)}
        accessibilityRole="button"
        accessibilityState={{ expanded: row.expanded }}
        style={({ pressed }) => [styles.groupHeader, pressed ? { backgroundColor: c.press } : null]}
        testID="process-toggle"
      >
        <Text
          style={{
            fontSize: font.size.meta,
            color: row.failed > 0 && !row.current ? c.err : c.ink3,
          }}
          numberOfLines={1}
        >
          {row.expanded ? '▾' : '▸'} {t('detail.activity')} · {steps}
          {tail}
          {inBackground > 0 ? (
            <Text style={{ color: c.accent }} testID="process-background">
              {` · ${t('background.inTurn', { count: inBackground })}`}
            </Text>
          ) : null}
        </Text>
      </Pressable>
    </View>
  )
})

function stateText(row: Extract<Row, { type: 'step' }>, t: Translator): string {
  if (row.state === 'running') return t('command.running')
  if (row.state === 'declined') return t('detail.step.declined')
  if (row.item.kind === 'command' && row.exitCode !== null && row.exitCode !== 0)
    return t('command.exitCode', { code: row.exitCode })
  if (row.state === 'failed') return t('detail.step.failed')
  return row.durationMs == null ? '' : t('detail.seconds', { s: seconds(row.durationMs) })
}

const stateColor = (state: StepState, c: Palette): string =>
  state === 'failed' ? c.err : state === 'running' ? c.wait : c.ink3

/** 展开的一组里的一步 */
export const StepCell = memo(function StepCell({ row }: Props<'step'>) {
  const { c, font } = useTheme()
  const t = useT()
  const { toggle, openLink } = useTranscript()
  const item = row.item
  const expandable =
    item.kind === 'command' || item.kind === 'fileChange' || item.kind === 'toolCall'
  let label: string
  switch (item.kind) {
    case 'command':
      label = `$ ${item.command}`
      break
    case 'fileChange':
      label = item.changes.map((change) => change.path).join(', ')
      break
    case 'toolCall':
      label = item.source ? `${t.text(item.source)} · ${t.text(item.tool)}` : t.text(item.tool)
      break
    case 'webSearch':
      label = t('detail.labelled', { head: t('search.verb'), text: item.query })
      break
    case 'notice':
      label = `${t.text(item.label)}${item.detail ? ` · ${item.detail}` : ''}`
      break
  }
  const press = expandable
    ? () => toggle(row.key, row.turnId)
    : item.kind === 'webSearch' && isWebUrl(item.query)
      ? () => openLink(item.query)
      : undefined
  const state = stateText(row, t)
  return (
    <View style={[styles.step, { borderLeftColor: c.line2 }]}>
      <Pressable
        onPress={press}
        disabled={!press}
        accessibilityState={expandable ? { expanded: row.expanded } : undefined}
        style={({ pressed }) => [styles.stepHead, pressed ? { backgroundColor: c.press } : null]}
        testID={`step:${item.kind}`}
      >
        <Text style={[styles.mark, { color: stateColor(row.state, c), fontFamily: font.mono }]}>
          {MARK[row.state]}
        </Text>
        <Text
          style={[cellStyles.grow, styles.stepLabel, { color: c.ink, fontFamily: font.mono }]}
          numberOfLines={row.expanded ? 6 : 2}
        >
          {label}
        </Text>
        {state ? (
          <Text style={[styles.stepState, { color: stateColor(row.state, c) }]}>{state}</Text>
        ) : null}
      </Pressable>
      {row.expanded ? <StepDetail row={row} /> : null}
    </View>
  )
})

/** 字节数给人看：1.2 KB 这样 */
export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** 等宽的一块字，长行横着滑，不折行 */
function Well({ children }: { children: ReactNode }) {
  const { c } = useTheme()
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.well, { backgroundColor: c.sunken, borderColor: c.line1 }]}
      contentContainerStyle={styles.wellInner}
    >
      <View>{children}</View>
    </ScrollView>
  )
}

function StepDetail({ row }: Props<'step'>) {
  switch (row.item.kind) {
    case 'command':
      return <CommandDetail row={row} />
    case 'fileChange':
      return <ChangeDetail row={row} />
    case 'toolCall':
      return <ToolDetail row={row} />
    default:
      return null
  }
}

/** 命令的输出：只露末尾几十行。输出被核心截过时说明中间省了多少 */
function CommandDetail({ row }: Props<'step'>) {
  const { c, font } = useTheme()
  const t = useT()
  if (row.item.kind !== 'command') return null
  const elided = row.item.elided
  const source = (elided ? row.tail : row.output).replace(/\s+$/, '')
  if (!source && !elided)
    return <Text style={[styles.note, { color: c.ink3 }]}>{t('detail.step.noOutput')}</Text>
  const lines = source.split('\n')
  const shown = lines.slice(-OUTPUT_LINES)
  const earlier = lines.length - shown.length
  const mono = { color: c.ink2, fontFamily: font.mono }
  return (
    <View>
      {elided ? (
        <Text style={[styles.note, { color: c.ink3 }]}>
          {t('command.elided', { size: sizeOf(elided.bytes) })}
        </Text>
      ) : null}
      {earlier > 0 ? (
        <Text style={[styles.note, { color: c.ink3 }]}>
          {t('detail.step.earlier', { n: earlier })}
        </Text>
      ) : null}
      <Well>
        <Text style={[styles.code, mono]}>{shown.join('\n')}</Text>
      </Well>
    </View>
  )
}

/** 差异行前面的符号：@@ 那一行原样，不加 */
const SIGN = { add: '+', del: '-', ctx: ' ', hunk: '' } as const

/** 改了哪些文件（点了到文件页），加上开头一小段差异 */
function ChangeDetail({ row }: Props<'step'>) {
  const { c, font } = useTheme()
  const t = useT()
  const { scope, openLink, openDiff } = useTranscript()
  if (row.item.kind !== 'fileChange') return null
  let budget = DIFF_LINES
  let hidden = 0
  const blocks = row.item.changes.map((change, index) => {
    const ref = scope ? knownFileRef(change.path, scope) : null
    const lines = budget > 0 ? diffLines(change) : []
    const shown = lines.slice(0, budget)
    budget -= shown.length
    hidden += lines.length - shown.length
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: 一次改动里的文件不会重排
      <View key={index} style={styles.change}>
        <Pressable disabled={!ref} onPress={() => ref && openLink(fileHref(ref))}>
          <Text style={{ fontSize: 12, fontFamily: font.mono, color: ref ? c.accent : c.ink }}>
            {t(`change.${change.change}`)} {change.path}{' '}
            <Text style={{ color: c.ok }}>+{change.added}</Text>{' '}
            <Text style={{ color: c.err }}>−{change.removed}</Text>
          </Text>
        </Pressable>
        {change.movedTo ? (
          <Text style={[styles.note, { color: c.ink3 }]}>
            {t('detail.step.moved', { path: change.movedTo })}
          </Text>
        ) : null}
        {shown.length > 0 ? (
          <Well>
            {shown.map((line, at) => (
              <Text
                // biome-ignore lint/suspicious/noArrayIndexKey: 差异的行按位置
                key={at}
                style={[
                  styles.code,
                  {
                    fontFamily: font.mono,
                    color:
                      line.type === 'add'
                        ? c.ok
                        : line.type === 'del'
                          ? c.err
                          : line.type === 'ctx'
                            ? c.ink2
                            : c.ink3,
                  },
                ]}
              >
                {line.type === 'gap'
                  ? t('diff.elided', { n: line.lines, size: sizeOf(line.bytes) })
                  : `${SIGN[line.type]}${line.text}`}
              </Text>
            ))}
          </Well>
        ) : null}
      </View>
    )
  })
  return (
    <View>
      {blocks}
      {hidden > 0 ? (
        <Pressable onPress={openDiff} accessibilityRole="link">
          <Text style={[styles.note, { color: c.accent }]}>
            {t('detail.step.moreLines', { n: hidden })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

/** 工具调用的参数和结果（或错误），各露一截 */
function ToolDetail({ row }: Props<'step'>) {
  const { c } = useTheme()
  const t = useT()
  if (row.item.kind !== 'toolCall') return null
  const { input, output, error } = row.item
  return (
    <View>
      {input.length > 0 ? <Parts title={t('tool.args')} parts={input} /> : null}
      {Array.isArray(error) ? (
        <Parts title={t('tool.error')} parts={error} tone="err" />
      ) : error ? (
        <Text style={[styles.note, { color: c.err }]}>{t.text(error)}</Text>
      ) : null}
      {output.length > 0 ? <Parts title={t('tool.result')} parts={output} /> : null}
    </View>
  )
}

function Parts({ title, parts, tone }: { title: string; parts: ToolPart[]; tone?: 'err' }) {
  const { c, font } = useTheme()
  const t = useT()
  const { viewImage } = useTranscript()
  let budget = TOOL_CHARS
  let shots = 0
  let cut = false
  /** 没露出来的段数（被截了一半的那段不算） */
  let rest = 0
  const shown: ReactNode[] = []
  for (const [at, part] of parts.entries()) {
    if (budget <= 0 || shown.length >= TOOL_PARTS) {
      rest = parts.length - at
      break
    }
    if (part.kind === 'text') {
      const text = part.text.length > budget ? `${part.text.slice(0, budget)}…` : part.text
      budget -= text.length
      if (text.length < part.text.length) cut = true
      shown.push(
        <Text
          style={[styles.code, { fontFamily: font.mono, color: tone === 'err' ? c.err : c.ink2 }]}
        >
          {text}
        </Text>,
      )
    } else if (part.kind === 'blob') {
      budget -= 40
      const desc = [
        t(`tool.blob.${part.type}`),
        part.mime,
        part.bytes === null ? null : sizeOf(part.bytes),
        part.name,
      ]
        .filter(Boolean)
        .join(' · ')
      shown.push(
        part.src && shots++ < TOOL_SHOTS ? (
          <Pressable onPress={() => part.src && viewImage(part.src)}>
            <Image source={{ uri: part.src }} style={[styles.shot, { borderColor: c.line2 }]} />
          </Pressable>
        ) : (
          <Text style={[styles.code, { fontFamily: font.mono, color: c.ink3 }]}>[{desc}]</Text>
        ),
      )
    } else {
      const size = sizeOf(part.bytes)
      const text =
        part.chars > 0 && part.parts > 0
          ? t('tool.elidedBoth', { size, n: part.parts })
          : part.parts > 0
            ? t('tool.elidedBlobs', { n: part.parts })
            : t('tool.elided', { size })
      shown.push(
        <Text style={[styles.code, { fontFamily: font.mono, color: c.ink3 }]}>{text}</Text>,
      )
    }
  }
  return (
    <View>
      <Text style={[styles.note, { color: c.ink3 }]}>{title}</Text>
      <Well>
        {/* 各段按位置排，不会重排：交给 toArray 按位置编键 */}
        {Children.toArray(shown)}
        {cut || rest > 0 ? (
          <Text style={[styles.code, { color: c.ink3 }]}>
            {rest > 0 ? t('detail.step.moreParts', { n: rest }) : '…'}
          </Text>
        ) : null}
      </Well>
    </View>
  )
}

const styles = StyleSheet.create({
  group: { paddingHorizontal: 16, paddingVertical: 2 },
  groupHeader: { height: 32, justifyContent: 'center' },
  step: {
    marginLeft: 16,
    marginRight: 16,
    borderLeftWidth: 2,
    paddingLeft: 10,
    paddingVertical: 2,
  },
  stepHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingVertical: 4 },
  mark: { fontSize: 13, lineHeight: 18, width: 14 },
  stepLabel: { fontSize: 13, lineHeight: 18 },
  stepState: { fontSize: 11, lineHeight: 18 },
  note: { fontSize: 11, lineHeight: 16, marginTop: 2 },
  well: { borderWidth: 1, marginTop: 4, marginBottom: 4 },
  wellInner: { padding: 8 },
  code: { fontSize: 12, lineHeight: 16 },
  change: { marginTop: 4 },
  shot: { width: 160, height: 100, borderWidth: 1, marginVertical: 2, resizeMode: 'contain' },
})
