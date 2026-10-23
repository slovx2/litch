// 对话区的各种行（过程那几种在 steps.tsx）。每个单元格按行对象 memo：行对象没换（rows.ts 的 keep）就不重画。
// 文字一律不可选：安卓上文本选择的监听在滚动时占主线程；复制走长按回合的菜单（长按用户消息、回答，或点状态行的“⋯”）。
// 颜色、字号只从主题取。会长高的东西（流式的那一块）之外，行的高度在内容不变时不变。
import { type FileScope, keys, parseAskReply, type SessionSummary } from '@litch/core'
import { memo, useEffect, useState } from 'react'
import {
  Image,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'
import { EnrichedMarkdownText, type MarkdownStyle } from 'react-native-enriched-markdown'
import type { Row } from '../core/rows'
import { experiment } from '../experiment'
import { noteWork } from '../probe'
import { useKey } from '../shell/services'
import { useT } from '../ui/i18n'
import { type Palette, useTheme } from '../ui/theme'
import { AskCell, AskReplyText, useAsks } from './asks/AskCell'
import { CommentCards, commentsOfRow } from './comments/CommentCards'
import { useComments, useFlashedRow } from './comments/context'
import { notePressedAnswer } from './comments/hub'
import { linkCommentRefs, parseCommentHref } from './comments/refs'
import { useTranscript } from './context'
import { linkify } from './links'
import { labelMermaid } from './mermaid'

export type Props<T extends Row['type']> = { row: Extract<Row, { type: T }> }

/** 秒数：一位小数，满一分钟写成“几分几秒”那样的就不必了，手机上一行放得下 */
export const seconds = (ms: number): string => (ms / 1000).toFixed(1)

const pressed = (c: Palette) => ({ backgroundColor: c.press })

export const UserCell = memo(function UserCell({ row }: Props<'user'>) {
  const { c, font } = useTheme()
  const t = useT()
  const { turnMenu, viewImage } = useTranscript()
  const images = row.attachments.filter((each) => each.kind === 'image' && each.url)
  const others = row.attachments.filter((each) => !(each.kind === 'image' && each.url))
  // 别的会话发来的：原话照登，不认答题、评论这些格式
  const peer = row.peer
  // 答模型边干活边问的题时发的那一段：画成题目和回答
  const replies = peer ? null : parseAskReply(row.text)
  // 开头带评论的：评论画成卡片，下面才是打的字
  const comments = replies || peer ? null : commentsOfRow(row)
  const text = comments ? comments.rest : row.text
  const menu = () => {
    notePressedAnswer(row.turnId, null)
    turnMenu(row.turnId)
  }
  return (
    <View style={styles.userWrap}>
      <Pressable
        onLongPress={menu}
        style={({ pressed: down }) => [
          styles.userBubble,
          peer
            ? { backgroundColor: c.panel, borderColor: c.line3, borderStyle: 'dashed' }
            : { backgroundColor: c.sunken, borderColor: c.line2 },
          down ? pressed(c) : null,
        ]}
        testID={peer ? 'peer-message' : 'user-message'}
      >
        {peer ? (
          <Text style={[styles.peerHead, { color: c.ink2, fontSize: font.size.meta }]}>
            <Text style={{ color: c.accent }}>✉ </Text>
            {peer.name ? t('peer.from', { name: peer.name }) : t('peer.fromUnnamed')}
            {peer.bypass ? <Text style={{ color: c.wait }}>{` · ${t('peer.bypass')}`}</Text> : null}
          </Text>
        ) : null}
        {images.length > 0 ? (
          <View style={styles.thumbs}>
            {images.map((image, index) => (
              <Pressable
                // biome-ignore lint/suspicious/noArrayIndexKey: 同一条消息里的图片不会重排
                key={index}
                accessibilityRole="imagebutton"
                accessibilityLabel={t('attachment.view')}
                onPress={() => image.url && viewImage(image.url)}
              >
                <Image
                  source={{ uri: image.url }}
                  style={[styles.thumb, { borderColor: c.line2 }]}
                />
              </Pressable>
            ))}
          </View>
        ) : null}
        {others.length > 0 ? (
          <View style={styles.chips}>
            {others.map((each, index) => (
              <Text
                // biome-ignore lint/suspicious/noArrayIndexKey: 同上
                key={index}
                numberOfLines={1}
                style={[
                  styles.chip,
                  { color: c.ink2, borderColor: c.line2, fontFamily: font.mono },
                ]}
              >
                {t(`attachment.${each.kind}`)}
                {each.label ? ` · ${each.label}` : ''}
              </Text>
            ))}
          </View>
        ) : null}
        {comments ? (
          <CommentCards comments={comments.comments} turnId={row.turnId} onLongPress={menu} />
        ) : null}
        {replies ? (
          <AskReplyText replies={replies} />
        ) : text ? (
          <Text style={[styles.userText, { color: c.ink, fontSize: font.size.body }]}>{text}</Text>
        ) : null}
      </Pressable>
    </View>
  )
})

/** 每套配色一份 Markdown 样式（对象不变，组件不会因为它重新排版） */
const styleCache = new WeakMap<Palette, MarkdownStyle>()

function markdownStyleOf(c: Palette, mono: string): MarkdownStyle {
  let style = styleCache.get(c)
  if (style) return style
  style = {
    paragraph: { fontSize: 15, lineHeight: 22, color: c.ink },
    h1: { fontSize: 20, lineHeight: 28, color: c.ink, fontWeight: '700' },
    h2: { fontSize: 19, lineHeight: 26, color: c.ink, fontWeight: '700' },
    h3: { fontSize: 17, lineHeight: 24, color: c.ink, fontWeight: '700' },
    list: { fontSize: 15, lineHeight: 22, color: c.ink },
    codeBlock: {
      fontSize: 13,
      lineHeight: 19,
      fontFamily: mono,
      color: c.ink,
      backgroundColor: c.sunken,
      borderColor: c.line1,
      borderWidth: 1,
      padding: 10,
      borderRadius: 0,
    },
    code: { fontSize: 13, fontFamily: mono, color: c.ink, backgroundColor: c.sunken },
    blockquote: { borderColor: c.line2, color: c.ink2 },
    link: { color: c.accent, underline: true },
    // 文件路径和网址一个颜色，只是不画下划线：改写前后字形一样（links.ts）
    linkVariants: {
      '^litch-file:': { color: c.accent, underline: false },
      // 回答里指向评论的 [N]（comments/refs.ts）：一个小记号
      '^litch-comment:': { color: c.accent, underline: false, backgroundColor: c.sel },
    },
    table: { borderColor: c.line2, headerBackgroundColor: c.sunken, color: c.ink },
  } as MarkdownStyle
  styleCache.set(c, style)
  return style
}

/**
 * 写完的块（不再长）第一次排好版后把高度钉死：宽高都定了，布局引擎就不再调它的测量函数。
 * 这个 Markdown 组件带表格时每次测量都整段重新解析、重新排版、不缓存，而它旁边的行一变，
 * 它所在的容器重新布局时就会被再测一遍。钉死以后，只有正在长的那一块在测量。
 * 钉的高度记在行对象上（不记在组件里）：列表会把单元格挪给别的行用，组件里的状态会跟着串到别的行去；
 * 记在行上还有一个好处，滑走再滑回来的行不用再量一遍。窗口宽度变了（转屏）就重新量
 */
const frozen = new WeakMap<Row, { width: number; height: number }>()

/** 一块回答或计划。带题的助手消息（模型边干活边问）画成问题卡片（asks/AskCell.tsx） */
export const MarkdownCell = memo(function MarkdownCell({ row }: Props<'md'>) {
  const questions = useAsks(row.itemId)
  if (questions) return <AskCell itemId={row.itemId} first={row.first} questions={questions} />
  return <MarkdownBody row={row} />
})

const MarkdownBody = memo(function MarkdownBody({ row }: Props<'md'>) {
  noteWork('mdCell', 0, row.text.length)
  const { c, font } = useTheme()
  const t = useT()
  const { scope, openLink, turnMenu } = useTranscript()
  const hub = useComments()
  const flashed = useFlashedRow(row.key)
  const { width } = useWindowDimensions()
  const [, setFrozenAt] = useState(0)
  const known = frozen.get(row)
  const height = !row.open && known?.width === width ? known.height : null
  const freeze =
    row.open || height !== null || !experiment.freeze
      ? undefined
      : (event: LayoutChangeEvent) => {
          frozen.set(row, { width, height: event.nativeEvent.layout.height })
          setFrozenAt(Date.now())
        }
  // 紧跟在带评论的用户消息之后、同一回合里的回答：[N] 画成能点的“评论 N”
  const comments = hub && !row.plan ? hub.commentsOf(row.turnId) : null
  const refs = comments ? { count: comments.comments.length, t } : null
  const markdown = labelMermaid(linkedText(row, scope, refs), t('mermaid.onDesktop'))
  const onLink = (url: string) => {
    const index = parseCommentHref(url)
    if (index === null) return openLink(url)
    const comment = comments?.comments[index - 1]
    if (comment) hub?.show({ comment, turnId: row.turnId })
  }
  const body =
    experiment.render === 'plain' ? (
      <Text style={{ fontSize: 15, lineHeight: 22, color: c.ink }}>{row.text}</Text>
    ) : (
      <EnrichedMarkdownText
        markdown={markdown}
        flavor="github"
        markdownStyle={markdownStyleOf(c, font.mono)}
        selectable={false}
        streamingConfig={streamingConfig}
        onLinkPress={(event) => onLink(event.url)}
        containerStyle={height === null ? undefined : { height }}
        onLayout={freeze}
      />
    )
  return (
    <Pressable
      onLongPress={() => {
        notePressedAnswer(row.turnId, row.itemId)
        turnMenu(row.turnId)
      }}
      style={[
        styles.md,
        row.plan ? [styles.plan, { borderLeftColor: c.line3 }] : null,
        flashed ? { backgroundColor: c.sel } : null,
      ]}
      testID="answer"
    >
      {row.plan && row.first ? (
        <Text style={[styles.planTitle, { color: c.ink2, fontFamily: font.mono }]}>
          {t('plan.title')}
        </Text>
      ) : null}
      {body}
    </Pressable>
  )
})

const streamingConfig = { tableMode: 'progressive', codeBlockMode: 'progressive' } as const

/** 改写过链接的字，按行对象记着：滑回来的行、流式时没变的块不用再扫一遍 */
const linked = new WeakMap<
  Row,
  { scope: FileScope | null; count: number; lang: string; text: string }
>()

/** refs：这一回合的用户消息带了几条评论（回答里的 [N] 改成记号，记号上的字随语言） */
function linkedText(
  row: Extract<Row, { type: 'md' }>,
  scope: FileScope | null,
  refs: { count: number; t: ReturnType<typeof useT> } | null,
): string {
  const count = refs?.count ?? 0
  const lang = refs?.t.lang ?? ''
  const known = linked.get(row)
  if (known?.scope === scope && known.count === count && known.lang === lang) return known.text
  // 先认路径和网址：它跳过已经有链接的行，评论的记号要后加
  let text = linkify(row.text, scope)
  if (refs) text = linkCommentRefs(text, count, (n) => refs.t('comment.ref', { n }))
  linked.set(row, { scope, count, lang, text })
  return text
}

/**
 * 思考：收起时一行次要的浅字（最后一行字），点开是全文。收起的那一行高度固定。没字的思考不画（rows.ts）。
 * 不写“想了一下”这类动词，在想的时候也只有思考的字：“{name} 正在工作”只写在状态行上，回合在忙只有一处在说
 */
export const ReasoningCell = memo(function ReasoningCell({ row }: Props<'reasoning'>) {
  const { c, font } = useTheme()
  const t = useT()
  const { toggle } = useTranscript()
  return (
    <Pressable
      onPress={() => toggle(row.key, row.turnId)}
      accessibilityHint={row.expanded ? undefined : t('detail.reasoning.tap')}
      style={({ pressed: down }) => [styles.reasoning, down ? pressed(c) : null]}
      testID="reasoning-toggle"
    >
      {row.expanded ? (
        <Text style={[styles.reasoningText, { color: c.ink3, fontSize: font.size.meta }]}>
          ▾ {row.text}
        </Text>
      ) : (
        <Text
          style={[styles.meta, styles.thought, { color: c.ink3, fontSize: font.size.meta }]}
          numberOfLines={1}
        >
          ▸ {row.text}
        </Text>
      )}
    </Pressable>
  )
})

/** 留空之后要持续这么久才再写“正在工作”：两段正文挨着出字时不来回闪（和桌面端一样） */
const WORKING_DELAY_MS = 300

function useLasting(on: boolean): boolean {
  const [lasted, setLasted] = useState(false)
  useEffect(() => {
    setLasted(false)
    if (!on) return
    const timer = setTimeout(() => setLasted(true), WORKING_DELAY_MS)
    return () => clearTimeout(timer)
  }, [on])
  return on && lasted
}

/** 从 since 起已经过了多久，每秒更新一次。since 是 null（不在显示、不知道何时开始）时不计时 */
function useTicking(since: number | null): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [since])
  return since === null ? null : Math.max(0, now - since)
}

/**
 * 回合末尾的状态行：从回合开始一直在，高度固定，只换字。回合在跑时写“{name} 正在工作”和已经用了多久，
 * 正文在出字、等人答复时留空；命令、工具、思考在跑时照写。右边一个“⋯”打开这一回合的操作
 */
export const StatusCell = memo(function StatusCell({ row }: Props<'status'>) {
  const { c, font } = useTheme()
  const t = useT()
  const { turnMenu, harness } = useTranscript()
  const working = useLasting(row.working)
  const spent = useTicking(working ? row.startedAt : null)
  const time =
    row.durationMs == null ? '' : ` · ${t('detail.seconds', { s: seconds(row.durationMs) })}`
  const text =
    row.status === 'running'
      ? working
        ? `${t('turn.working', { name: harness })}${
            spent !== null && spent >= 1000
              ? ` · ${t('detail.seconds', { s: String(Math.floor(spent / 1000)) })}`
              : ''
          }`
        : ''
      : row.status === 'completed'
        ? `${t('turn.completed')}${time}`
        : row.status === 'interrupted'
          ? `${t('turn.interrupted')}${time}`
          : t('turn.failed')
  return (
    <View style={styles.status}>
      <Text
        style={[
          styles.meta,
          styles.grow,
          { color: row.status === 'failed' ? c.err : c.ink3, fontSize: font.size.small + 1 },
        ]}
        numberOfLines={1}
      >
        {text}
      </Text>
      {row.status === 'running' ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('detail.menu.more')}
          hitSlop={{ top: 10, bottom: 10, left: 14, right: 14 }}
          onPress={() => {
            notePressedAnswer(row.turnId, null)
            turnMenu(row.turnId)
          }}
          style={({ pressed: down }) => [styles.more, down ? pressed(c) : null]}
          testID="turn-menu"
        >
          <Text style={[styles.meta, { color: c.ink3, fontFamily: font.mono }]}>⋯</Text>
        </Pressable>
      )}
    </View>
  )
})

/** 失败的回合带的原因（对面的原话） */
export const ErrorCell = memo(function ErrorCell({ row }: Props<'error'>) {
  const { c, font } = useTheme()
  return (
    <View style={[styles.error, { borderColor: c.err, backgroundColor: c.raised }]}>
      <Text style={{ color: c.err, fontSize: font.size.meta, lineHeight: 19 }}>{row.text}</Text>
    </View>
  )
})

/** 一行说明：上下文压缩、进入审查模式这类事件 */
export const NoticeCell = memo(function NoticeCell({ row }: Props<'notice'>) {
  const { c, font } = useTheme()
  const t = useT()
  return (
    <View style={styles.notice}>
      <Text style={[styles.meta, { color: c.ink3, fontSize: font.size.meta }]} numberOfLines={2}>
        ── {t.text(row.label)}
        {row.detail ? ` · ${row.detail}` : ''}
      </Text>
    </View>
  )
})

/** 压了这么久还没完，后面加一句“可能要几分钟”（和桌面端一样 10 秒） */
const COMPACTION_SLOW_MS = 10_000

/** 上下文压缩：一条分隔线，字在中间。压的时候写“正在压缩上下文”，压完写已压缩，没压完回合就停了写没完成 */
export const CompactionCell = memo(function CompactionCell({ row }: Props<'compaction'>) {
  const { c, font } = useTheme()
  const t = useT()
  const running = row.status === 'inProgress'
  const spent = useTicking(running ? row.startedAt : null)
  const label = running
    ? t(spent !== null && spent >= COMPACTION_SLOW_MS ? 'compaction.slow' : 'compaction.running')
    : row.status === 'interrupted'
      ? t('compaction.interrupted')
      : t(row.source === 'manual' ? 'compaction.manual' : 'compaction.automatic')
  return (
    <View style={styles.compaction} testID="compaction">
      <View style={[styles.compactionLine, { backgroundColor: c.line2 }]} />
      <Text
        style={[
          styles.meta,
          styles.compactionText,
          { color: running ? c.ink2 : c.ink3, fontSize: font.size.meta },
        ]}
        numberOfLines={2}
      >
        {label}
      </Text>
      <View style={[styles.compactionLine, { backgroundColor: c.line2 }]} />
    </View>
  )
})

/** 会话最上面：从哪个会话分叉出来的。原会话这台设备上还有，点名字过去 */
export const ForkedCell = memo(function ForkedCell({ row }: Props<'forked'>) {
  const { c, font } = useTheme()
  const t = useT()
  const { deviceId, openSession } = useTranscript()
  const source = useKey<SessionSummary>(keys.summary(deviceId, row.from))
  return (
    <View style={[styles.forked, { borderBottomColor: c.line1 }]}>
      <Text style={[styles.meta, { color: c.ink3, fontSize: font.size.meta }]}>
        {t('transcript.forkedFrom')}{' '}
      </Text>
      {source ? (
        <Pressable
          accessibilityRole="link"
          accessibilityHint={t('transcript.forkedFrom.open')}
          onPress={() => openSession(row.from)}
          style={styles.grow}
          testID="forked-from"
        >
          <Text
            numberOfLines={1}
            style={[styles.meta, { color: c.accent, fontSize: font.size.meta }]}
          >
            {t.text(source.title)}
          </Text>
        </Pressable>
      ) : (
        <Text style={[styles.meta, { color: c.ink3, fontSize: font.size.meta }]}>
          {t('transcript.forkedFrom.unknown')}
        </Text>
      )}
    </View>
  )
})

const TODO_MARK = { pending: '[ ]', inProgress: '[~]', completed: '[x]' } as const

/** 待办：模型自己列的几步，做到哪了。整份原地换 */
export const TodoCell = memo(function TodoCell({ row }: Props<'todo'>) {
  const { c, font } = useTheme()
  const t = useT()
  const done = row.steps.filter((step) => step.status === 'completed').length
  return (
    <View style={[styles.todo, { borderColor: c.line2, backgroundColor: c.raised }]}>
      <Text
        style={[styles.meta, { color: c.ink2, fontSize: font.size.meta, fontFamily: font.mono }]}
      >
        {t('todo.title')} · {t('todo.count', { done, total: row.steps.length })}
      </Text>
      {row.note ? (
        <Text style={{ color: c.ink2, fontSize: font.size.meta, lineHeight: 19 }}>{row.note}</Text>
      ) : null}
      {row.steps.map((step, index) => {
        // 回合结束时还标着“正在做”的，算没做完
        const status = step.status === 'inProgress' && !row.running ? 'pending' : step.status
        return (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: 待办整份换，按位置对就行
            key={index}
            style={styles.todoStep}
          >
            <Text style={[styles.todoMark, { color: c.ink3, fontFamily: font.mono }]}>
              {TODO_MARK[status]}
            </Text>
            <Text
              style={[
                styles.grow,
                {
                  color: status === 'completed' ? c.ink3 : c.ink,
                  fontSize: font.size.meta + 1,
                  lineHeight: 20,
                  fontWeight: status === 'inProgress' ? '600' : 'normal',
                  textDecorationLine: status === 'completed' ? 'line-through' : 'none',
                },
              ]}
            >
              {step.text}
            </Text>
          </View>
        )
      })}
    </View>
  )
})

export const styles = StyleSheet.create({
  grow: { flex: 1 },
  meta: { fontSize: 13 },
  userWrap: { paddingHorizontal: 16, paddingVertical: 6, alignItems: 'flex-end' },
  userBubble: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    maxWidth: '85%',
    gap: 6,
  },
  userText: { lineHeight: 22 },
  peerHead: { fontWeight: '600' },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  thumb: { width: 72, height: 72, borderWidth: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { fontSize: 11, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2, maxWidth: 220 },
  md: { paddingHorizontal: 16, paddingVertical: 4 },
  plan: { borderLeftWidth: 2, marginLeft: 16, paddingLeft: 12 },
  planTitle: { fontSize: 11, marginBottom: 2 },
  reasoning: { paddingHorizontal: 16, minHeight: 28, justifyContent: 'center', paddingVertical: 4 },
  reasoningText: { lineHeight: 19, marginTop: 4 },
  thought: { fontStyle: 'italic' },
  status: {
    paddingHorizontal: 16,
    height: 26,
    flexDirection: 'row',
    alignItems: 'center',
  },
  more: { paddingHorizontal: 8, height: 26, justifyContent: 'center' },
  error: { marginHorizontal: 16, marginVertical: 4, borderWidth: 1, padding: 10 },
  notice: { paddingHorizontal: 16, paddingVertical: 4 },
  compaction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  compactionLine: { flex: 1, minWidth: 16, height: StyleSheet.hairlineWidth },
  compactionText: { flexShrink: 1, textAlign: 'center' },
  forked: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  todo: { marginHorizontal: 16, marginVertical: 6, borderWidth: 1, padding: 10, gap: 4 },
  todoStep: { flexDirection: 'row', gap: 8 },
  todoMark: { fontSize: 13, lineHeight: 20 },
})
