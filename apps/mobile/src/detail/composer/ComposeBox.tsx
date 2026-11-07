// 输入框那一块：要带的图片、多行输入框、“+”和发送（排队、停止）两个按钮，有用量时中间一个上下文小圆环。
// “+”点开是一张单：添加图片，加上对话参数（模型、强度、速度、权限、计划模式，各写着现在的值）。参数不常改，
// 收在这里不占屏幕高度；计划模式开着时“+”上有个强调色的点，读屏名称也说明。
// 会话详情和新建会话页共用；发去哪、发成功没有由外面定，这里只管写、清空、没发成时还回来。
// 草稿按会话记（drafts.ts）：文字和图片落盘。软键盘回车换行；外接键盘 Enter 发送，Shift+Enter 换行。
// 选中回答加的评论也是草稿的一部分（落盘），一条一片排在最上面；只有评论、没打字也能发。
// 打 `@` 在输入框上面列这台设备上的会话（MentionList.tsx），点了写成 @[标题]，发出去时随消息带上是哪个会话。
import {
  type CommentExtra,
  type ImageAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_COMMENTS,
  type MessageExtra,
  parentPath,
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
import { HardwareKeyboard } from '../../../modules/litch-keyboard/src/HardwareKeyboard'
import { navigationRef } from '../../shell/dev-links'
import { useServices } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Sheet, type SheetAction } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'
import { CommentChips } from '../comments/CommentChips'
import { FileCard } from '../FileCard'
import { colors } from '../theme'
import { ImageViewer } from '../turn-menu'
import {
  dropDraft,
  flushDrafts,
  loadDraft,
  loadDraftComments,
  loadDraftFiles,
  loadDraftImages,
  loadDraftSessions,
  type SessionExtra,
  saveDraft,
  saveDraftComments,
  saveDraftFiles,
  saveDraftImages,
  saveDraftSessions,
  subscribeDraftComments,
} from './drafts'
import { type FileExtra, pickFile } from './files'
import { useGrow } from './grow'
import { MAX_IMAGE_MB, MAX_IMAGES, pickImages, REFUSAL_TEXT } from './images'
import { rowLayout } from './layout'
import { useMentionInput } from './MentionInput'
import { MentionList, mentionTrigger } from './MentionList'
import { type SettingsProps, useComposeSettings } from './SettingsBar'
import { sendButton, takesSend } from './send-mode'
import { UsageRing } from './UsageRing'

export interface Draft {
  imageStorageError?: boolean
  text: string
  images: ImageAttachment[]
  /** 选中回答加的评论，按加的先后 */
  comments: CommentExtra[]
  /** 打 @ 提到的会话。正文里那几个字删掉了就跟着去掉 */
  sessions: SessionExtra[]
  files: FileExtra[]
  setFiles(update: (current: FileExtra[]) => FileExtra[]): void
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
    files?: FileExtra[],
  ): void
  clear(): void
}

/** 一个会话的草稿。换了会话（键变了）就换一份 */
export function useDraft(key: string): Draft {
  const [imageStorageError, setImageStorageError] = useState(false)
  const [state, setState] = useState(() => ({
    key,
    text: loadDraft(key),
    images: loadDraftImages(key),
    sessions: loadDraftSessions(key),
    files: loadDraftFiles(key),
  }))
  const current =
    state.key === key
      ? state
      : {
          key,
          text: loadDraft(key),
          images: loadDraftImages(key),
          sessions: loadDraftSessions(key),
          files: loadDraftFiles(key),
        }
  if (current !== state) setState(current)
  useEffect(() => {
    saveDraft(key, current.text)
  }, [key, current.text])
  useEffect(() => {
    setImageStorageError(saveDraftImages(key, current.images) !== null)
  }, [key, current.images])
  useEffect(() => {
    saveDraftSessions(key, current.sessions)
  }, [key, current.sessions])
  useEffect(() => {
    saveDraftFiles(key, current.files)
  }, [key, current.files])
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
  const setFiles = useCallback(
    (update: (list: FileExtra[]) => FileExtra[]) =>
      setState((s) => {
        if (s.key === key) return { ...s, files: update(s.files) }
        saveDraftFiles(key, update(loadDraftFiles(key)))
        return s
      }),
    [key],
  )
  const setComments = useCallback((list: CommentExtra[]) => saveDraftComments(key, list), [key])
  const refill = useCallback(
    (
      text: string,
      images: ImageAttachment[],
      back: CommentExtra[] = [],
      mentioned: SessionExtra[] = [],
      files: FileExtra[] = [],
    ) => {
      if (back.length)
        saveDraftComments(key, [...back, ...loadDraftComments(key)].slice(0, MAX_COMMENTS))
      setState((s) => ({
        ...s,
        text: s.text && text ? `${text}\n${s.text}` : text || s.text,
        images: [...images, ...s.images].slice(0, MAX_IMAGES),
        files: [...files, ...s.files],
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
    setState((s) => ({ ...s, text: '', images: [], sessions: [], files: [] }))
  }, [key])
  return {
    imageStorageError,
    text: current.text,
    images: current.images,
    comments,
    sessions: current.sessions,
    files: current.files,
    setFiles,
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
  pending = null,
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
  /**
   * 停止后有待发：输入框有内容时发送键旁出一个小开关“含 N 条”，开着这条连同待发一起发（默认）、
   * 关着只发这条。没有待发是 null
   */
  pending?: { count: number; include: boolean; toggle(): void } | null
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
  const { channel } = useServices()
  const [uploading, setUploading] = useState(false)
  const uploadingRef = useRef(false)
  // 草稿的这一版：内容一变就换一个。发出去时记下，连点时第二下拿到的还是这一版，不再发一次
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖就是草稿的内容，内容一变换一个新的对象
  const version = useMemo(
    () => ({}),
    [draft.text, draft.images, draft.comments, draft.sessions, draft.files],
  )
  const taken = useRef<object | null>(null)
  const own = useRef<TextInput>(null)
  const [viewingImage, setViewingImage] = useState<string | null>(null)
  const input = inputRef ?? own
  const grow = useGrow(input, draft.text)
  /** 光标在哪：认 `@` 用。还没动过光标的当在末尾 */
  const [caret, setCaret] = useState<number | null>(null)
  const trigger = mentions ? mentionTrigger(draft.text, caret) : null
  // 提到的会话在输入框里画成片（MentionInput.tsx）
  const chipped = useMentionInput({
    input,
    text: draft.text,
    setText: draft.setText,
    sessions: draft.sessions,
    onSelect: (selection) => setCaret(selection.end),
  })
  const filled =
    draft.text.trim().length > 0 ||
    draft.images.length > 0 ||
    draft.comments.length > 0 ||
    draft.files.length > 0
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
    if (uploadingRef.current) return
    const text = draft.text.trim()
    const images = draft.images
    const comments = draft.comments
    const files = draft.files
    const sessions = keepMentioned(draft.sessions, text)
    const content = text.length > 0 || images.length > 0 || comments.length > 0 || files.length > 0
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
    onSend(text, images, [...comments, ...sessions, ...files])
      .catch((reason: unknown) => {
        draft.refill(text, images, comments, sessions, files)
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

  const addFile = async () => {
    if (!mentions || uploadingRef.current) return
    if (draft.files.length + draft.comments.length + draft.sessions.length >= 16) {
      onError(t('composer.extra.count', { max: 16 }))
      return
    }
    uploadingRef.current = true
    setUploading(true)
    onError(null)
    try {
      const file = await pickFile(channel, mentions.deviceId)
      if (file?.kind === 'image') {
        if (imagesOff) onError(imagesOff)
        else if (draft.images.length >= MAX_IMAGES)
          onError(t('composer.image.count', { max: MAX_IMAGES }))
        else draft.setImages((list) => [...list, { name: file.name, url: file.url }])
      } else if (file) draft.setFiles((list) => [...list, file])
    } catch (reason) {
      onError(
        reason instanceof Error && reason.message === 'imageTooLarge'
          ? t('composer.image.size', { max: MAX_IMAGE_MB })
          : reason instanceof Error && reason.message === 'fileTooLarge'
            ? t('composer.file.uploadSize', {
                name: t('attachment.file'),
                max: MAX_ATTACHMENT_BYTES / 1024 / 1024,
              })
            : t('composer.failed', { reason: whyNot(reason, t) }),
      )
    } finally {
      uploadingRef.current = false
      setUploading(false)
    }
  }
  const config = useComposeSettings(settings)
  const [moreOpen, setMoreOpen] = useState(false)
  const planOn = config.plan?.on ?? false
  const moreActions: SheetAction[] = [
    ...(mentions
      ? [
          {
            label: t('compose.addFile'),
            testID: `${testID}-file`,
            onPress: () => void addFile(),
            ...(uploading ? { disabled: t('composer.file.uploading') } : {}),
          },
        ]
      : []),
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

  const note = error ?? (draft.imageStorageError ? t('composer.image.draftSave') : null) ?? blocked
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
      {uploading ? (
        <Text accessibilityRole="text" style={{ color: c.ink3 }}>
          {t('composer.file.uploading')}
        </Text>
      ) : null}
      {draft.files.map((file, index) => (
        <FileCard
          key={file.path}
          deviceId={mentions?.deviceId}
          file={{ ...file, kind: file.folder ? 'folder' : 'file', label: file.name }}
          onPress={() => {
            if (mentions)
              navigationRef.navigate('Files', {
                deviceId: mentions.deviceId,
                root: parentPath(file.path) ?? '/',
                path: file.path,
              })
          }}
          onRemove={() => draft.setFiles((list) => list.filter((_, at) => at !== index))}
        />
      ))}
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
          numberOfLines={blocked ? undefined : 3}
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
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('tool.image.view')}
                testID={`${testID}-image-view-${index}`}
                onPress={() => setViewingImage(image.url)}
              >
                <Image source={{ uri: image.url }} style={styles.thumbImage} resizeMode="cover" />
              </Pressable>
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
        <HardwareKeyboard
          style={styles.keyboard}
          submitEnabled={filled && !blocked && !uploading}
          onSubmit={send}
        >
          <TextInput
            ref={input}
            {...chipped.props}
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
          >
            {chipped.children}
          </TextInput>
        </HardwareKeyboard>
        {config.percent !== null ? (
          <UsageRing
            percent={config.percent}
            {...(settings?.onUsage ? { onPress: settings.onUsage } : {})}
          />
        ) : null}
        {pending && filled ? (
          <View style={styles.pendingSlot}>
            <Pressable
              accessibilityRole="switch"
              aria-checked={pending.include}
              accessibilityLabel={t('composer.pendingWith', { n: pending.count })}
              accessibilityHint={t('composer.pendingWith.note', { n: pending.count })}
              testID={`${testID}-pending`}
              hitSlop={8}
              onPress={pending.toggle}
              style={[
                styles.pending,
                {
                  borderColor: pending.include ? c.accent : c.line2,
                  backgroundColor: pending.include ? c.sel : 'transparent',
                },
              ]}
            >
              <Text style={[styles.pendingText, { color: pending.include ? c.accent : c.ink3 }]}>
                {t('compose.pendingShort', { n: pending.count })}
              </Text>
            </Pressable>
          </View>
        ) : null}
        {/* 发送、排队、停止：36 的圆形图标键（↑、■），读屏名称写是哪一个；这一格随输入框拉高、键贴底 */}
        <View style={styles.send}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={sendLabel}
            accessibilityState={{
              disabled: mode !== 'stop' && (!filled || !!blocked || uploading),
            }}
            testID={`${testID}-send`}
            // 36 见方，四边放 4：可点 44
            hitSlop={4}
            onPress={send}
            style={({ pressed }) => [
              styles.sendDot,
              {
                backgroundColor: mode === 'stop' ? 'transparent' : c.accentSolid,
                borderColor: mode === 'stop' ? c.err : c.accentSolid,
                opacity:
                  mode !== 'stop' && (!filled || blocked || uploading) ? 0.45 : pressed ? 0.75 : 1,
              },
            ]}
          >
            <Text
              style={[
                mode === 'stop' ? styles.stopGlyph : styles.sendGlyph,
                { color: mode === 'stop' ? c.err : c.onAccent },
              ]}
            >
              {mode === 'stop' ? '■' : '↑'}
            </Text>
          </Pressable>
        </View>
      </View>
      <ImageViewer
        url={viewingImage}
        onClose={() => {
          setViewingImage(null)
          requestAnimationFrame(() => input.current?.focus())
        }}
      />
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
  sendGlyph: { fontSize: 20, lineHeight: 24, fontWeight: '700' },
  stopGlyph: { fontSize: 13, lineHeight: 16 },
  pendingSlot: { justifyContent: 'flex-end', paddingBottom: 6 },
  pending: {
    height: 28,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderRadius: 14,
    justifyContent: 'center',
  },
  pendingText: { fontSize: 12 },
})
