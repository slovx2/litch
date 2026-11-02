// 输入框那一块：要带的图片、多行输入框、“+”和发送（排队、停止）两个按钮，有用量时中间一个上下文小圆环。
// “+”点开是一张单：添加图片，加上对话参数（模型、强度、速度、权限、计划模式，各写着现在的值）。参数不常改，
// 收在这里不占屏幕高度；计划模式开着时“+”上有个强调色的点，读屏名称也说明。
// 会话详情和新建会话页共用；发去哪、发成功没有由外面定，这里只管写、清空、没发成时还回来。
// 草稿按会话记（drafts.ts）：文字落盘，图片只在内存里。回车在手机上是换行，发送只靠按钮。
// 选中回答加的评论也是草稿的一部分（落盘），一条一片排在最上面；只有评论、没打字也能发。
// 打 `@` 在输入框上面列这台设备上的会话（MentionList.tsx），点了写成 @[标题]，发出去时随消息带上是哪个会话。
import {
  type CommentExtra,
  type ImageAttachment,
  MAX_COMMENTS,
  type MessageExtra,
} from '@litch/core'
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import { keepMentioned } from '../../../../../packages/ui/src/composer/session-hits.ts'
import { useT } from '../../ui/i18n'
import { Sheet, type SheetAction } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'
import { CommentChips } from '../comments/CommentChips'
import { colors } from '../theme'
import {
  dropDraft,
  flushDrafts,
  loadDraft,
  loadDraftComments,
  loadDraftImages,
  loadDraftSessions,
  type SessionExtra,
  saveDraft,
  saveDraftComments,
  saveDraftImages,
  saveDraftSessions,
  subscribeDraftComments,
} from './drafts'
import { useGrow } from './grow'
import { MAX_IMAGE_MB, MAX_IMAGES, pickImages, REFUSAL_TEXT } from './images'
import { rowLayout } from './layout'
import { MentionList, mentionTrigger } from './MentionList'
import { type SettingsProps, useComposeSettings } from './SettingsBar'
import { sendButton, takesSend } from './send-mode'
import { UsageRing } from './UsageRing'

export interface Draft {
  text: string
  images: ImageAttachment[]
  /** 选中回答加的评论，按加的先后 */
  comments: CommentExtra[]
  /** 打 @ 提到的会话。正文里那几个字删掉了就跟着去掉 */
  sessions: SessionExtra[]
  setText(text: string): void
  /** 选中一个会话：换上新的字，记下这个会话 */
  mention(text: string, extra: SessionExtra): void
  setImages(update: (current: ImageAttachment[]) => ImageAttachment[]): void
  setComments(list: CommentExtra[]): void
  /** 把一段话、几张图、评论和提到的会话放回输入框（没发出去的、从队列里拿回来改的），接在现有的后面 */
  refill(
    text: string,
    images: ImageAttachment[],
    comments?: CommentExtra[],
    sessions?: SessionExtra[],
  ): void
  clear(): void
}

/** 一个会话的草稿。换了会话（键变了）就换一份 */
export function useDraft(key: string): Draft {
  const [state, setState] = useState(() => ({
    key,
    text: loadDraft(key),
    images: loadDraftImages(key),
    sessions: loadDraftSessions(key),
  }))
  const current =
    state.key === key
      ? state
      : {
          key,
          text: loadDraft(key),
          images: loadDraftImages(key),
          sessions: loadDraftSessions(key),
        }
  if (current !== state) setState(current)
  useEffect(() => {
    saveDraft(key, current.text)
  }, [key, current.text])
  useEffect(() => {
    saveDraftImages(key, current.images)
  }, [key, current.images])
  useEffect(() => {
    saveDraftSessions(key, current.sessions)
  }, [key, current.sessions])
  // 评论另有一份，对话区的全文页也会往里加：订阅着
  const comments = useSyncExternalStore(subscribeDraftComments, () => loadDraftComments(key))
  // 离开页面时把攒着的草稿写进文件
  useEffect(() => () => flushDrafts(), [])
  const setText = useCallback(
    (text: string) => setState((s) => ({ ...s, text, sessions: keepMentioned(s.sessions, text) })),
    [],
  )
  const mention = useCallback(
    (text: string, extra: SessionExtra) =>
      setState((s) => ({
        ...s,
        text,
        sessions: [...s.sessions.filter((one) => one.threadId !== extra.threadId), extra],
      })),
    [],
  )
  const setImages = useCallback(
    (update: (list: ImageAttachment[]) => ImageAttachment[]) =>
      setState((s) => ({ ...s, images: update(s.images) })),
    [],
  )
  const setComments = useCallback((list: CommentExtra[]) => saveDraftComments(key, list), [key])
  const refill = useCallback(
    (
      text: string,
      images: ImageAttachment[],
      back: CommentExtra[] = [],
      mentioned: SessionExtra[] = [],
    ) => {
      if (back.length)
        saveDraftComments(key, [...back, ...loadDraftComments(key)].slice(0, MAX_COMMENTS))
      setState((s) => ({
        ...s,
        text: s.text && text ? `${text}\n${s.text}` : text || s.text,
        images: [...images, ...s.images].slice(0, MAX_IMAGES),
        sessions: [
          ...mentioned,
          ...s.sessions.filter((one) => !mentioned.some((back) => back.threadId === one.threadId)),
        ],
      }))
    },
    [key],
  )
  const clear = useCallback(() => {
    dropDraft(key)
    setState((s) => ({ ...s, text: '', images: [], sessions: [] }))
  }, [key])
  return {
    text: current.text,
    images: current.images,
    comments,
    sessions: current.sessions,
    setText,
    mention,
    setImages,
    setComments,
    refill,
    clear,
  }
}

export function ComposeBox({
  draft,
  placeholder,
  running,
  steer = false,
  steerImages = true,
  fresh = false,
  blocked,
  imagesOff,
  error,
  top,
  settings = null,
  markers,
  inputRef,
  mentions,
  onSend,
  onStop,
  onError,
  testID = 'composer',
}: {
  inputRef?: RefObject<TextInput | null>
  draft: Draft
  placeholder: string
  /** 回合在跑：有字时按钮是“发送”（插进当前回合）或“排队”，没字时是“停止”（给了 onStop 的话） */
  running: boolean
  /** 回合在跑时发出去会插进当前回合（设置里选了立即发送、这个会话插得了话）。不给是排队 */
  steer?: boolean
  /** 新建会话：上一条还在建会话时不接下一条，免得另建一个 */
  fresh?: boolean
  /** 插话收不收图片：不收时带着图片的那条照样排队，按钮写“排队” */
  steerImages?: boolean
  /** 发不了的原因（设备没连上、harness 用不了）。照样能写草稿 */
  blocked: string | null
  /** 带不了图片的原因。null 是能带 */
  imagesOff: string | null
  /** 外面要说的一句（没发出去、没停下来）。null 是没有 */
  error: string | null
  /** 输入框上面的东西：排着队的消息 */
  top?: ReactNode
  /** 对话参数（收在“+”里）。不给是没有，“+”里只有添加图片 */
  settings?: SettingsProps | null
  markers?: boolean
  /** 打 `@` 列哪台设备上的会话、当前是哪个会话（新建页上没有）。不给就不列 */
  mentions?: { deviceId: string; sessionId: string | null }
  /**
   * 发出去：extras 是评论和提到的会话（正文里还写着的）。出错时把文字、图片、评论、提到的会话还回输入框，
   * 并给外面一个说法
   */
  onSend(text: string, images: ImageAttachment[], extras: MessageExtra[]): Promise<void>
  onStop?(): void
  onError(message: string | null): void
  testID?: string
}) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const [sending, setSending] = useState(false)
  // 草稿的这一版：内容一变就换一个。发出去时记下，连点时第二下拿到的还是这一版，不再发一次
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖就是草稿的内容，内容一变换一个新的对象
  const version = useMemo(() => ({}), [draft.text, draft.images, draft.comments, draft.sessions])
  const taken = useRef<object | null>(null)
  const own = useRef<TextInput>(null)
  const input = inputRef ?? own
  const grow = useGrow(input, draft.text)
  /** 光标在哪：认 `@` 用。还没动过光标的当在末尾 */
  const [caret, setCaret] = useState<number | null>(null)
  const trigger = mentions ? mentionTrigger(draft.text, caret) : null
  const filled =
    draft.text.trim().length > 0 || draft.images.length > 0 || draft.comments.length > 0
  const mode = sendButton({
    filled,
    running,
    steer: steer && (steerImages || draft.images.length === 0),
    stoppable: onStop !== undefined,
  })

  const send = () => {
    if (mode === 'stop') {
      onStop?.()
      return
    }
    const text = draft.text.trim()
    const images = draft.images
    const comments = draft.comments
    const sessions = keepMentioned(draft.sessions, text)
    const content = text.length > 0 || images.length > 0 || comments.length > 0
    if (!takesSend({ filled: content, blocked: Boolean(blocked), sending, fresh })) return
    if (taken.current === version) return
    if (images.length > 0 && imagesOff) {
      onError(imagesOff)
      return
    }
    taken.current = version
    // 先清空：消息已经显示在对话里了。没发成功再还回来
    draft.clear()
    onError(null)
    setSending(true)
    onSend(text, images, [...comments, ...sessions])
      .catch((reason: unknown) => {
        draft.refill(text, images, comments, sessions)
        onError(t('composer.failed', { reason: whyNot(reason, t) }))
      })
      .finally(() => setSending(false))
  }

  const addImages = async () => {
    if (imagesOff) {
      onError(imagesOff)
      return
    }
    const picked = await pickImages(MAX_IMAGES - draft.images.length)
    if (!picked) return
    if (picked.images.length)
      draft.setImages((list) => [...list, ...picked.images].slice(0, MAX_IMAGES))
    onError(
      picked.refused
        ? t(REFUSAL_TEXT[picked.refused], {
            max: picked.refused === 'size' ? MAX_IMAGE_MB : MAX_IMAGES,
          })
        : null,
    )
  }

  const config = useComposeSettings(settings)
  const [moreOpen, setMoreOpen] = useState(false)
  const planOn = config.plan?.on ?? false
  const moreActions: SheetAction[] = [
    {
      label: t('compose.addImage'),
      testID: `${testID}-image`,
      onPress: () => void addImages(),
      ...(imagesOff ? { disabled: imagesOff } : {}),
    },
    ...config.entries.map((entry) => ({
      label: entry.title,
      value: entry.value,
      testID: entry.testID,
      onPress: entry.open,
    })),
    ...(config.plan
      ? [
          {
            label: t('composer.plan'),
            checked: config.plan.on,
            testID: 'settings:plan',
            onPress: config.plan.toggle,
          },
        ]
      : []),
  ]

  const note = error ?? blocked
  const sendLabel =
    mode === 'stop'
      ? t('composer.stop')
      : mode === 'queue'
        ? t('composer.queue')
        : t('composer.send')
  return (
    <View
      testID={testID}
      style={[styles.box, { backgroundColor: c.panel, borderTopColor: c.line2 }]}
    >
      {markers ? <View style={styles.mark} /> : null}
      {top}
      <CommentChips comments={draft.comments} onChange={draft.setComments} testID={testID} />
      {mentions && trigger ? (
        <MentionList
          deviceId={mentions.deviceId}
          sessionId={mentions.sessionId}
          text={draft.text}
          trigger={trigger}
          bound={draft.sessions}
          onPick={(next, extra) => {
            draft.mention(next.text, extra)
            setCaret(next.caret)
          }}
          testID={testID}
        />
      ) : null}
      {note ? (
        <Text
          testID={`${testID}-note`}
          numberOfLines={3}
          style={[styles.note, { color: error ? c.err : c.ink2 }]}
        >
          {note}
        </Text>
      ) : null}
      {draft.images.length > 0 ? (
        <ScrollView horizontal style={styles.strip} contentContainerStyle={styles.stripIn}>
          {draft.images.map((image, index) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: 同一张图可以加两次，缩略图没有自己的状态
              key={`${index}:${image.url.length}`}
              style={[styles.thumb, { borderColor: c.line2, borderRadius: theme.radius.s }]}
            >
              <Image source={{ uri: image.url }} style={styles.thumbImage} resizeMode="cover" />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('composer.image.remove')}
                testID={`${testID}-image-remove-${index}`}
                hitSlop={6}
                onPress={() => draft.setImages((list) => list.filter((_, at) => at !== index))}
                style={[styles.thumbX, { backgroundColor: c.invBg }]}
              >
                <Text style={{ color: c.invFg, fontSize: 12 }}>✕</Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(planOn ? 'compose.more.plan' : 'compose.more')}
          testID={`${testID}-more`}
          hitSlop={6}
          onPress={() => setMoreOpen(true)}
          style={[
            styles.side,
            { borderColor: planOn ? c.accent : c.line2, borderRadius: theme.radius.m },
          ]}
        >
          <Text style={[styles.sideText, { color: c.ink }]}>＋</Text>
          {planOn ? (
            <View
              testID={`${testID}-more-plan`}
              style={[styles.planDot, { backgroundColor: c.accentSolid, borderColor: c.panel }]}
            />
          ) : null}
        </Pressable>
        <TextInput
          ref={input}
          value={draft.text}
          onChangeText={draft.setText}
          onSelectionChange={(event) => setCaret(event.nativeEvent.selection.end)}
          placeholder={placeholder}
          placeholderTextColor={c.ink3}
          multiline
          {...grow}
          testID={`${testID}-input`}
          style={[
            styles.input,
            {
              color: c.ink,
              backgroundColor: c.raised,
              borderColor: c.line2,
              borderRadius: theme.radius.m,
              fontSize: theme.font.size.body,
              fontFamily: theme.font.ui,
            },
          ]}
        />
        {config.percent !== null ? (
          <UsageRing
            percent={config.percent}
            {...(settings?.onUsage ? { onPress: settings.onUsage } : {})}
          />
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={sendLabel}
          accessibilityState={{ disabled: mode !== 'stop' && (!filled || !!blocked) }}
          testID={`${testID}-send`}
          onPress={send}
          style={({ pressed }) => [
            styles.send,
            {
              borderRadius: theme.radius.m,
              backgroundColor: mode === 'stop' ? 'transparent' : c.accentSolid,
              borderColor: mode === 'stop' ? c.err : c.accentSolid,
              opacity: mode !== 'stop' && (!filled || blocked) ? 0.45 : pressed ? 0.75 : 1,
            },
          ]}
        >
          <Text style={[styles.sendText, { color: mode === 'stop' ? c.err : c.onAccent }]}>
            {sendLabel}
          </Text>
        </Pressable>
      </View>
      <Sheet
        visible={moreOpen}
        title={t('compose.more.title')}
        actions={moreActions}
        onClose={() => setMoreOpen(false)}
      />
      {config.pickers}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { borderTopWidth: 1, paddingTop: 8 },
  mark: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: colors.markComposer,
  },
  note: { fontSize: 13, paddingHorizontal: 12, paddingBottom: 6 },
  strip: { flexGrow: 0 },
  stripIn: { gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  thumb: { width: 56, height: 56, borderWidth: 1 },
  thumbImage: { width: '100%', height: '100%' },
  thumbX: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ...rowLayout,
  sideText: { fontSize: 22, lineHeight: 26 },
  planDot: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
  },
  sendText: { fontSize: 15, fontWeight: '600' },
})
