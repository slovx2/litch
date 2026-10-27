// 对话区的各种行（过程那几种在 steps.tsx）。每个单元格按行对象 memo：行对象没换（rows.ts 的 keep）就不重画。
// 文字平时不可选：安卓上文本选择的监听在滚动时占主线程；复制走长按回合的菜单（长按用户消息、回答，或点状态行的“⋯”）。
// 长按菜单里点了“选择文字”的那条回答例外：它的几块能自由选字，系统的选字菜单里多一个“回复”（comments/hub.ts）。
// 颜色、字号只从主题取。会长高的东西（流式的那一块）之外，行的高度在内容不变时不变。
import { type FileScope, keys, parseAskReply, type SessionSummary } from '@litch/core'
import { memo, useEffect, useMemo, useState } from 'react'
import {
  Image,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'
import { EnrichedMarkdownText } from 'react-native-enriched-markdown'
import {
  duration,
  elapsed,
  retryText,
  stamp,
  turnEnded,
} from '../../../../packages/ui/src/app/format.ts'
import type { Row } from '../core/rows'
import { experiment } from '../experiment'
import { noteWork } from '../probe'
import { useKey } from '../shell/services'
import { useT } from '../ui/i18n'
import { type Palette, useTheme } from '../ui/theme'
import { AskCell, AskReplyText, useAsks } from './asks/AskCell'
import { CommentCards, commentsOfRow } from './comments/CommentCards'
import { useComments, useFlashedRow, useHubValue } from './comments/context'
import { notePressed } from './comments/hub'
import { linkCommentRefs, parseCommentHref } from './comments/refs'
import { useToggleInPlace, useTranscript } from './context'
import { linkify } from './links'
import { markdownStyleOf } from './markdownStyle'
import { MermaidCard } from './mermaid/MermaidCard'
import { splitMermaid } from './mermaid/segments'
import { MentionedText } from './SessionMentions'
import { currentStep, todoProgress } from './todo/logic'
import { TodoSteps } from './todo/TodoViews'

export type Props<T extends Row['type']> = { row: Extract<Row, { type: T }> }

const pressed = (c: Palette) => ({ backgroundColor: c.press })

/** 别的会话发来的话超过这么多行、字先收起来 */
const PEER_LINES = 4
const PEER_CHARS = 200

export const UserCell = memo(function UserCell({ row }: Props<'user'>) {
  const theme = useTheme()
  const { c, font, radius } = theme
  const t = useT()
  const { turnMenu, viewImage } = useTranscript()
  const toggle = useToggleInPlace()
  const images = row.attachments.filter((each) => each.kind === 'image' && each.url)
  const others = row.attachments.filter((each) => !(each.kind === 'image' && each.url))
  // 别的会话发来的：原话照登，不认答题、评论这些格式
  const peer = row.peer
  // 答模型边干活边问的题时发的那一段：画成题目和回答
  const replies = peer ? null : parseAskReply(row.text)
  // 开头带评论的：评论画成卡片，下面才是打的字
  const comments = replies || peer ? null : commentsOfRow(row)
  const text = comments ? comments.rest : row.text
  // 别的会话发来的长话先收成几行，点一下在原处展开、再点收起
  const folds =
    peer !== undefined && (text.length > PEER_CHARS || text.split('\n').length > PEER_LINES)
  const menu = () => {
    notePressed(row.turnId, row.key)
    turnMenu(row.turnId)
  }
  return (
    <View style={styles.userWrap}>
      <Pressable
        onLongPress={menu}
        onPress={folds ? () => toggle(row.key, row.turnId) : undefined}
        accessibilityState={folds ? { expanded: row.expanded === true } : undefined}
        style={({ pressed: down }) => [
          styles.userBubble,
          // 气泡右下角收小一点，像从右边说出来的；人文皮肤是强调色的淡底、不画线
          { borderRadius: radius.l, borderBottomRightRadius: radius.s },
          peer
            ? { backgroundColor: c.panel, borderColor: c.line3, borderStyle: 'dashed' }
            : theme.skin === 'human'
              ? { backgroundColor: c.sel, borderColor: 'transparent' }
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
                  style={[styles.thumb, { borderColor: c.line2, borderRadius: radius.s }]}
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
                  {
                    color: c.ink2,
                    borderColor: c.line2,
                    borderRadius: radius.s,
                    fontFamily: font.mono,
                  },
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
          <Text
            numberOfLines={folds && !row.expanded ? PEER_LINES : undefined}
            style={[
              styles.userText,
              { color: c.ink, fontSize: font.size.body, fontFamily: font.ui },
            ]}
          >
            {peer ? text : <MentionedText text={text} sessions={row.sessions} />}
          </Text>
        ) : null}
        {folds ? (
          <Text style={{ color: c.accent, fontSize: font.size.meta }}>
            {t(row.expanded ? 'sysmsg.collapse' : 'sysmsg.expand')}
          </Text>
        ) : null}
      </Pressable>
      {/* 发送的时刻：手机上没有悬停，常显在气泡下面（照 Claude 桌面端在触屏上常显） */}
      {row.sentAt === undefined ? null : (
        <Text style={[styles.userTime, { color: c.ink3, fontSize: font.size.small }]}>
          {stamp(row.sentAt, Date.now(), t.lang)}
        </Text>
      )}
    </View>
  )
})

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
  const theme = useTheme()
  const { c, font } = theme
  const t = useT()
  const { scope, openLink, turnMenu } = useTranscript()
  const hub = useComments()
  const flashed = useFlashedRow(row.key)
  // 长按菜单里点了“选择文字”：这条回答的每一块都能选字，长按不再出回合的菜单（长按是系统的选字）
  const selecting = useHubValue(hub, (each) => each.selecting === row.itemId, false)
  // 紧跟在带评论的用户消息之后、同一回合里的回答：[N] 画成能点的“评论 N”
  const comments = hub && !row.plan ? hub.commentsOf(row.turnId) : null
  const refs = comments ? { count: comments.comments.length, t } : null
  const markdown = linkedText(row, scope, refs)
  // 写完的 mermaid 块拆出来画成卡片，前后的字照旧交给 Markdown 组件
  const segments = useMemo(() => splitMermaid(markdown), [markdown])
  const whole = segments.length === 1 && segments[0]?.kind === 'md'
  const { width } = useWindowDimensions()
  const [, setFrozenAt] = useState(0)
  // 钉高度只给整块是一段字的：带卡片的块分成了几段，卡片高度本来就固定
  const known = whole ? frozen.get(row) : undefined
  const height = !row.open && known?.width === width ? known.height : null
  const freeze =
    !whole || row.open || height !== null || !experiment.freeze
      ? undefined
      : (event: LayoutChangeEvent) => {
          frozen.set(row, { width, height: event.nativeEvent.layout.height })
          setFrozenAt(Date.now())
        }
  const onLink = (url: string) => {
    const index = parseCommentHref(url)
    if (index === null) return openLink(url)
    const comment = comments?.comments[index - 1]
    if (comment) hub?.show({ comment, turnId: row.turnId })
  }
  const prose = (text: string, key?: string) => (
    <EnrichedMarkdownText
      key={key}
      markdown={text}
      flavor="github"
      markdownStyle={markdownStyleOf(theme)}
      selectable={selecting}
      {...(selecting && hub
        ? {
            contextMenuItems: [
              {
                text: t('comment.reply'),
                onPress: ({ text: picked }: { text: string }) => hub.reply(row.itemId, picked),
              },
            ],
            selectionMenuConfig: {
              copy: { label: t('comment.copy') },
              copyAsMarkdown: { label: t('comment.copyMarkdown') },
              copyImageUrl: { enabled: false },
            },
          }
        : {})}
      streamingConfig={streamingConfig}
      onLinkPress={(event) => onLink(event.url)}
      containerStyle={height === null ? undefined : { height }}
      onLayout={freeze}
    />
  )
  const body =
    experiment.render === 'plain' ? (
      <Text style={{ fontSize: 15, lineHeight: 22, color: c.ink }}>{row.text}</Text>
    ) : whole ? (
      prose(markdown)
    ) : (
      segments.map((segment) =>
        segment.kind === 'md' ? (
          prose(segment.text, `t${segment.at}`)
        ) : (
          <MermaidCard key={`d${segment.at}`} source={segment.source} />
        ),
      )
    )
  return (
    <Pressable
      // 选字时这一层不接触摸：Pressable 一拿到 JS 的触摸响应，RN 就让它这一层拦下之后的移动事件，
      // 手指稍一抖，里面的文字就收到取消，系统的长按选字起不来（只有一点不动的长按才行）
      disabled={selecting}
      onLongPress={
        selecting
          ? undefined
          : () => {
              notePressed(row.turnId, row.itemId)
              turnMenu(row.turnId)
            }
      }
      style={[
        styles.md,
        row.plan ? [styles.plan, { borderLeftColor: c.line3 }] : null,
        // 选字时铺一层淡底，看得出能选的是哪条（不改边距：钉过高度的块宽度一变会排出不同的行数）
        flashed || selecting ? { backgroundColor: c.sel } : null,
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
  // 全文在这一行下面长出来：开头不动
  const toggle = useToggleInPlace()
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
export function useTicking(since: number | null): number | null {
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
  // 模型请求在重试时一直写着：手机上窄，第几次和原因写在最前面，不再写“正在工作”
  const retry = row.status === 'running' ? row.retry : null
  const working = useLasting(row.working) || retry !== null
  const spent = useTicking(working ? row.startedAt : null)
  const time = row.durationMs == null ? '' : ` · ${duration(row.durationMs, t)}`
  // 回合结束的时刻（开始加用时），写在用时后面
  const ended = turnEnded(row)
  const at = ended === null ? '' : ` · ${stamp(ended, Date.now(), t.lang)}`
  const took = spent !== null && spent >= 1000 ? ` · ${elapsed(spent, t)}` : ''
  const text =
    row.status === 'running'
      ? retry
        ? took
        : working
          ? `${t('turn.working', { name: harness })}${took}`
          : ''
      : row.status === 'completed'
        ? `${t('turn.completed')}${time}${at}`
        : row.status === 'interrupted'
          ? `${t('turn.interrupted')}${time}${at}`
          : `${t('turn.failed')}${at}`
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
        {retry ? <Text style={{ color: c.wait }}>{retryText(retry, t)}</Text> : null}
        {text}
      </Text>
      {row.status === 'running' ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('detail.menu.more')}
          hitSlop={{ top: 10, bottom: 10, left: 14, right: 14 }}
          onPress={() => {
            notePressed(row.turnId, null)
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
  const theme = useTheme()
  const { c, font } = theme
  return (
    <View
      style={[
        styles.error,
        { borderColor: c.err, backgroundColor: c.raised, borderRadius: theme.radius.l },
      ]}
    >
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

/**
 * 设备服务重启时这个会话的回合被打断了（SessionSummary.restarted）：对话区最下面一条分隔线，说发消息就能接着做。
 * 再开始一个回合，核心就去掉这个记号。画法和压缩那一条一样
 */
export function RestartNoteCell() {
  const { c, font } = useTheme()
  const t = useT()
  const { deviceId, sessionId } = useTranscript()
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  if (summary?.restarted === undefined) return null
  return (
    <View style={styles.compaction} testID="restart-note">
      <View style={[styles.compactionLine, { backgroundColor: c.line2 }]} />
      <Text
        style={[styles.meta, styles.compactionText, { color: c.ink3, fontSize: font.size.meta }]}
        numberOfLines={2}
      >
        {t('restart.note')}
      </Text>
      <View style={[styles.compactionLine, { backgroundColor: c.line2 }]} />
    </View>
  )
}

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

/**
 * 待办：模型自己列的几步，做到哪了。整份原地换。平时只一行（做到第几步、正在做哪一步），点了在原处展开整份；
 * 最近那份另在输入框上方有个小按钮（todo/TodoViews.tsx），对话里不再画整块
 */
export const TodoCell = memo(function TodoCell({ row }: Props<'todo'>) {
  const { c, font, todo } = useTheme()
  const t = useT()
  const toggle = useToggleInPlace()
  const { done, total } = todoProgress(row.steps)
  const now = currentStep(row.steps, row.running)
  return (
    <Pressable
      onPress={() => toggle(row.key, row.turnId)}
      accessibilityRole="button"
      accessibilityState={{ expanded: row.expanded }}
      accessibilityHint={row.expanded ? undefined : t('detail.todo.tap')}
      style={({ pressed: down }) => [styles.todo, down ? pressed(c) : null]}
      testID="todo:row"
    >
      <View style={styles.todoStep}>
        <Text style={[styles.todoMark, { color: c.ink3, fontFamily: font.mono }]}>
          {row.expanded ? '▾' : done === total ? todo.completed : todo.inProgress}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.grow, styles.todoLine, { color: c.ink2, fontSize: font.size.meta }]}
        >
          {t('todo.title')} · {t('todo.count', { done, total })}
          {now && !row.expanded ? ` · ${now.text}` : ''}
        </Text>
      </View>
      {row.expanded ? (
        <View style={styles.todoBody}>
          <TodoSteps note={row.note} steps={row.steps} running={row.running} />
        </View>
      ) : null}
    </Pressable>
  )
})

export const styles = StyleSheet.create({
  grow: { flex: 1 },
  meta: { fontSize: 13 },
  userWrap: { paddingHorizontal: 16, paddingVertical: 6, alignItems: 'flex-end' },
  userTime: { marginTop: 3, marginRight: 2 },
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
  todo: { paddingHorizontal: 16, paddingVertical: 4, minHeight: 28, justifyContent: 'center' },
  todoStep: { flexDirection: 'row', gap: 8 },
  todoMark: { fontSize: 13, lineHeight: 20 },
  todoLine: { lineHeight: 20 },
  todoBody: { gap: 4, marginTop: 4, paddingLeft: 4 },
})
