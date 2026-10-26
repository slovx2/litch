import {
  type ContextUsage,
  type DeviceView,
  type ImageAttachment,
  type ItemView,
  keys,
  type MessageExtra,
  pathTwin,
  type QueuedMessage,
  type RequestView,
  type SessionMeta,
  type SessionSettings,
  type TurnView,
} from '@litch/core'
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { requestNewSession } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { nameOf } from '../app/device.ts'
import { reasonOf } from '../app/errors.ts'
import { Clip, Close, Send, Stop } from '../app/icons.tsx'
import { currentPlatform } from '../app/platform.ts'
import { useKey, useServices } from '../app/services.tsx'
import { notesKey, takeNotes, withNotes } from '../diff/annotations.ts'
import { noteWords, PendingNotes } from '../diff/Notes.tsx'
import { useGoalSend } from '../goal/send.ts'
import { commentsOf } from '../transcript/comments/Cite.tsx'
import { revealOrigin } from '../transcript/comments/locate.ts'
import {
  commentExtra,
  removeComment,
  sendComment,
  updateComment,
  useDraftComments,
} from '../transcript/comments/model.ts'
import { CommentChip, ExtraChip, useExtraLabel } from './Chips.tsx'
import { type Compaction, ContextMeter } from './ContextMeter.tsx'
import {
  dropDraft,
  insertIntoDraft,
  joinDraft,
  leadDraft,
  loadDraftComments as loadComments,
  loadDraft,
  loadDraftExtras,
  loadDraftImages,
  mentionText,
  onMention,
  onPrefill,
  onRefill,
  saveDraft,
  saveDraftComments,
  saveDraftExtras,
  saveDraftImages,
} from './drafts.ts'
import { ESC_WINDOW, type EscArm, escStep, listenEscape } from './escape.ts'
import {
  EXTRAS_LIMIT,
  fileExtra,
  inlineText,
  mergeExtras,
  pasteVerdict,
  TEXT_LIMIT,
  tidyText,
} from './extras.ts'
import { type FilesResult, readFiles } from './files.ts'
import { useGrabFocus } from './focus.ts'
import {
  hasFiles,
  IMAGE_TYPES,
  type ImageRefusal,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  readImages,
} from './images.ts'
import { switchedProvider } from './provider-switch.ts'
import { SettingsBar, useComposeOptions } from './SettingsBar.tsx'
import { useRunningSend } from './send-mode.ts'
import { runningPlaceholder } from './send-mode-logic.ts'
import { keepMentioned } from './session-hits.ts'
import { useSuggest } from './useSuggest.tsx'

interface ComposerProps {
  deviceId: string
  /** 已有的会话才给：评论的片能直接发出去、能定位原文 */
  sessionId?: string
  /** 消息发给这台设备上的哪个 harness：底栏能选什么按它取。还不知道就不给 */
  harness?: string | undefined
  /** 草稿按这个键存 */
  draftKey: string
  /** 工作目录：技能按它取。还没有（不属于工作区的新对话）就不给 */
  cwd?: string | null
  placeholder: string
  /** 发不了的原因（设备离线、所属的 harness 现在不可用）。有它的时候输入框还能写，只是不能发 */
  blocked: string | null
  /** 底栏最前面另外放的东西（新建会话时选 harness 的那个选择器） */
  lead?: ReactNode
  /** 紧挨在输入框下面另外放的一排（新建对话页上选设备和工作区的那两个选择器） */
  below?: ReactNode
  /** 这是在新建会话：会话建好之后换不了的那几档权限，这时可以选 */
  fresh?: boolean
  /** 有回合在进行：这时发的消息会排队（steerNow 时直接插进去），没字的时候主按钮是停止 */
  running: boolean
  /** 在跑的是哪个回合：两下 Esc 得在同一个回合里按（escape.ts） */
  turnId?: string
  /** 有请求卡片等着回答：这时的 Esc 留给卡片（拒绝），不拿来打断 */
  asking?: boolean
  /** 回合进行中发的消息直接插进这个回合（设置里选了立即发送、这个会话也插得了话）：主按钮照常是“发送” */
  steerNow?: boolean
  queued: QueuedMessage[]
  settings: SessionSettings
  onSettings(patch: Partial<SessionSettings>): void
  /** 上下文占用。新建会话还没有，不给 */
  usage?: ContextUsage | null
  /** 手动压缩上下文。已有的会话才给 */
  compact?: Compaction
  /** 这个会话里发过的话，从早到晚。按上箭头翻的时候才来要，不给就没有输入历史 */
  history?(): string[]
  /** 开一个新对话（输入框里的 /new）。已有的会话才给 */
  onNew?(): void
  /** 发出去。受理了就算成；不成时输入框把文字、图片和附带项还给用户，并显示原因 */
  onSend(text: string, images: ImageAttachment[], extras: MessageExtra[]): Promise<unknown>
  onStop?(): Promise<unknown>
  onUnqueue?(messageId: string): void
  /** 把一条排着队的消息现在就插进正在进行的回合里。不给就没有这个按钮 */
  onSteer?(messageId: string): Promise<unknown>
  /** 带图片的消息插不插得进去。不给当作可以 */
  steerImages?: boolean
  /** 没发成时怎么说。不给就说“没发出去” */
  failure?(reason: string): string
  /** 底栏的选择器先不出（新建页上对面的默认还在问，显示的值还定不下来） */
  holdSettings?: boolean
}

/** 输入框最多长到这么高，再多就在里面滚 */
const MAX_HEIGHT = 220

/** 输入区：多行输入、图片、附带项、草稿、发送／排队／停止、排队托盘、底栏。往哪发由用它的一方决定 */
export function Composer(props: ComposerProps) {
  const { deviceId, sessionId, draftKey, blocked, running, queued, onSend, onStop, onUnqueue } =
    props
  const { failure, onSteer } = props
  const t = useT()
  const { channel, replica } = useServices()
  /** 选中回答加的评论：按会话存在 drafts.ts 里，对话区也在看（原文上的标记） */
  const comments = useDraftComments(draftKey)
  const labelOf = useExtraLabel()
  const [text, setText] = useState(() => loadDraft(draftKey))
  const [images, setImages] = useState(() => loadDraftImages(draftKey))
  /** 图片之外随消息带的：选中的技能、贴进来的长文字、提到的文件 */
  const [extras, setExtras] = useState(() => loadDraftExtras(draftKey))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** 有文件正拖在输入区上面 */
  const [dropping, setDropping] = useState(false)
  const asked = useComposeOptions(deviceId, props.harness)
  const options = props.holdSettings ? null : asked
  /** 这个会话能不能设持续目标（输入框里的 /goal）。新建对话页上没有会话，按 harness 的声明 */
  const sessionMeta = useKey<SessionMeta>(sessionId ? keys.session(deviceId, sessionId) : '')
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  /** 正在翻输入历史：翻到倒数第几条，以及翻之前写了一半的字。没在翻就是 null */
  const recalling = useRef<{ back: number; draft: string } | null>(null)
  /** 字换好之后光标该落在哪（从单子里选了一项，触发词拿掉了） */
  const landing = useRef<number | null>(null)
  useGrabFocus(input)

  // 草稿跟着会话走：写一个字存一次，切走再回来还在
  useEffect(() => {
    saveDraft(draftKey, text)
  }, [draftKey, text])
  useEffect(() => {
    saveDraftImages(draftKey, images)
  }, [draftKey, images])
  useEffect(() => {
    saveDraftExtras(draftKey, extras)
  }, [draftKey, extras])
  // 提到的会话跟着正文走：@[标题] 那几个字删掉了，就不再带这个会话
  useEffect(() => {
    setExtras((current) => keepMentioned(current, text))
  }, [text])
  // 别处把一段话放回来（回退之后把原来那条消息还给用户改）：放进输入框，光标落到末尾
  useEffect(
    () =>
      onRefill(draftKey, (back, attached) => {
        recalling.current = null
        setText((current) => joinDraft(back, current))
        setImages((current) => [...attached, ...current].slice(0, MAX_IMAGES))
        requestAnimationFrame(() => {
          const area = input.current
          if (!area) return
          area.focus()
          area.setSelectionRange(area.value.length, area.value.length)
        })
      }),
    [draftKey],
  )
  // 带预填地开过来（配置助手按钮）：那句放在最前面、原来的字接在后面，技能片加上，光标落到末尾
  useEffect(
    () =>
      onPrefill(draftKey, (lead, more) => {
        recalling.current = null
        setText((current) => leadDraft(lead, current))
        if (more.length > 0) setExtras((current) => mergeExtras(current, more))
        requestAnimationFrame(() => {
          const area = input.current
          if (!area) return
          area.focus()
          area.setSelectionRange(area.value.length, area.value.length)
        })
      }),
    [draftKey],
  )
  const device = useKey<DeviceView>(keys.device(deviceId))
  // 别处往输入框里加一样东西（文件面板的“加入对话”）：变成带着的一片，焦点回到输入框。
  // 带了行号的片上放不下，写成字插在光标那里。文件和工作目录可能是同一个目录的两种写法（pathTwin）
  const cwd = props.cwd ?? null
  const os = device?.os
  useEffect(
    () =>
      onMention((mention) => {
        const area = input.current
        if (!area) return false
        recalling.current = null
        // 引用一个会话：只收同一台设备上的别的会话，写成 @[标题] 插在光标那里，另外记下是哪个
        if (mention.kind === 'session') {
          if (mention.deviceId !== deviceId || mention.threadId === sessionId) return false
          const next = insertIntoDraft(
            area.value,
            `@[${mention.title}]`,
            area.selectionStart,
            area.selectionEnd,
          )
          setText(next.text)
          setExtras((current) =>
            mergeExtras(current, [
              { kind: 'session', threadId: mention.threadId, title: mention.title },
            ]),
          )
          requestAnimationFrame(() => {
            area.focus()
            area.setSelectionRange(next.caret, next.caret)
          })
          return true
        }
        if (!mention.line) {
          setExtras((current) => mergeExtras(current, [fileExtra(mention, cwd, pathTwin(os))]))
          requestAnimationFrame(() => area.focus())
          return true
        }
        const next = insertIntoDraft(
          area.value,
          mentionText(mention),
          area.selectionStart,
          area.selectionEnd,
        )
        setText(next.text)
        requestAnimationFrame(() => {
          area.focus()
          area.setSelectionRange(next.caret, next.caret)
        })
        return true
      }),
    [cwd, os, deviceId, sessionId],
  )

  // 输入框跟着内容长高。先收回去再量，删字的时候才会变矮
  // biome-ignore lint/correctness/useExhaustiveDependencies: 文字变了就要重新量
  useLayoutEffect(() => {
    const area = input.current
    if (!area) return
    area.style.height = 'auto'
    area.style.height = `${Math.min(area.scrollHeight, MAX_HEIGHT)}px`
    if (landing.current !== null) {
      area.setSelectionRange(landing.current, landing.current)
      landing.current = null
    }
  }, [text])

  // 选的模型不收图片：带着图就不让发，免得发出去才报错
  const model = options?.models.find((entry) => entry.id === props.settings.model)
  // 这个 harness 声明了自己收不了图片：图片加不上，草稿里留着图的也不让发（device 在上面取过）
  // 消息发给本机设备：harness 和这个界面在同一台机器上，文件可以按路径提到。远程设备上只带得了文本文件的内容
  const local = device?.kind === 'local'
  const declared = device?.harnesses.find((entry) => entry.id === props.harness)?.abilities
  const noImages = declared?.images === false
  const imagesRefused =
    images.length > 0 && (noImages || (model !== undefined && !model.acceptsImages))
  const filled =
    text.trim().length > 0 || images.length > 0 || extras.length > 0 || comments.length > 0
  /** 输入框上面出片的那几样：提到的会话写在正文里，不算 */
  const chipped = extras.filter((extra) => extra.kind !== 'session').length
  const ready = filled && !blocked && !busy && !imagesRefused

  const suggest = useSuggest({
    deviceId,
    sessionId,
    mentioned: extras.flatMap((extra) => (extra.kind === 'session' ? [extra.threadId] : [])),
    harness: props.harness,
    cwd: props.cwd ?? null,
    fresh: props.fresh,
    text,
    input,
    pickers: [
      ...(options && options.models.length > 0 ? ['model'] : []),
      ...(model && model.efforts.length > 0 ? ['effort'] : []),
      ...(options && options.permissions.length > 0 ? ['permission'] : []),
    ],
    compact: props.compact,
    goal: sessionId ? sessionMeta?.can.goals === true && sessionMeta.live : undefined,
    onNew: props.onNew,
    plan: options?.plan
      ? {
          on: props.settings.mode === 'plan',
          toggle: () =>
            props.onSettings({ mode: props.settings.mode === 'plan' ? 'default' : 'plan' }),
        }
      : undefined,
    edit: (next, caret) => {
      recalling.current = null
      landing.current = caret
      setText(next)
    },
    addExtra: (extra) => setExtras((current) => mergeExtras(current, [extra])),
  })

  const refusalText = (why: ImageRefusal): string => {
    if (why === 'size') return t('composer.image.size', { max: MAX_IMAGE_BYTES / 1024 / 1024 })
    if (why === 'count') return t('composer.image.count', { max: MAX_IMAGES })
    return t(`composer.image.${why}`)
  }

  const fileRefusalText = ({ why, name }: NonNullable<FilesResult['refused']>): string => {
    if (why === 'count') return t('composer.extra.count', { max: EXTRAS_LIMIT })
    if (why === 'size') {
      return t('composer.file.size', { name, max: TEXT_LIMIT.toLocaleString(t.lang) })
    }
    // 不是文本、内容带不了：说清楚为什么不能按路径提到它
    if (why === 'binary')
      return t(local ? 'composer.file.binary' : 'composer.file.remote', { name })
    return t(`composer.file.${why}`, { name })
  }

  /** 选中的、拖进来的、贴进来的文件：图片内联进消息，别的按路径提到或者把内容当文字带（见 files.ts） */
  const addFiles = (files: File[], named: boolean) => {
    if (files.length === 0) return
    const pictures = files.filter((file) => IMAGE_TYPES.includes(file.type))
    const others = files.filter((file) => !IMAGE_TYPES.includes(file.type))
    void Promise.all([
      noImages ? null : readImages(pictures, MAX_IMAGES - images.length, named),
      readFiles(others, {
        local,
        pathOf: (file) => window.litchShell?.pathOf(file) ?? '',
        room: EXTRAS_LIMIT - extras.length - comments.length,
      }),
    ]).then(([shots, rest]) => {
      if (shots && shots.images.length > 0) {
        setImages((current) => [...current, ...shots.images].slice(0, MAX_IMAGES))
      }
      if (rest.extras.length > 0) setExtras((current) => mergeExtras(current, rest.extras))
      setError(
        shots === null && pictures.length > 0
          ? t('composer.image.refused')
          : shots?.refused
            ? refusalText(shots.refused)
            : rest.refused
              ? fileRefusalText(rest.refused)
              : null,
      )
    })
  }

  /** 按了第一下 Esc：在哪个回合里、什么时候，到点作废的计时（下面的两下 Esc 停） */
  const [armed, setArmed] = useState(false)
  const arm = useRef<{ at: EscArm | null; timer?: ReturnType<typeof setTimeout> }>({ at: null })
  const disarm = useCallback(() => {
    clearTimeout(arm.current.timer)
    arm.current = { at: null }
    setArmed(false)
  }, [])

  const send = useCallback(() => {
    const content = text.trim()
    const attached = images
    const carried = extras
    const commented = comments
    if (!content && attached.length === 0 && carried.length === 0 && commented.length === 0) return
    // 先清空：消息已经显示在对话里了。没发成功再把文字、图片和附带项还回来
    recalling.current = null
    disarm()
    setText('')
    setImages([])
    setExtras([])
    dropDraft(draftKey)
    saveDraftComments(draftKey, [])
    setError(null)
    setBusy(true)
    // 评论排在最前面（核心并进正文时也是写在最前面）
    onSend(content, attached, [...commented.map(commentExtra), ...carried])
      .catch((reason: unknown) => {
        setText((current) => (current && content ? `${content}\n${current}` : content || current))
        setImages((current) => [...attached, ...current].slice(0, MAX_IMAGES))
        setExtras((current) => mergeExtras(carried, current))
        saveDraftComments(draftKey, [...commented, ...loadComments(draftKey)])
        const why = reasonOf(reason, t)
        setError(failure ? failure(why) : t('composer.failed', { reason: why }))
      })
      .finally(() => setBusy(false))
  }, [onSend, failure, draftKey, text, images, extras, comments, t, disarm])

  const stop = () => {
    setError(null)
    onStop?.().catch((reason: unknown) => {
      setError(t('composer.interruptFailed', { reason: reasonOf(reason, t) }))
    })
  }

  // 回合在跑时按两下 Esc 停（escape.ts）：第一下上膛、底栏写一句“再按一次”，2 秒内再按才停。
  // 输入框里的字不动，停了焦点回到输入框。回合换了、停了、发了消息，上的膛都作废
  const stopNow = useRef(stop)
  stopNow.current = stop
  const stoppable = running && Boolean(onStop) && !props.asking
  const turnId = props.turnId ?? ''
  useEffect(() => {
    const area = input.current
    if (!stoppable || !area) return
    const off = listenEscape({
      input: area,
      handle(event) {
        event.preventDefault()
        const now = Date.now()
        if (escStep(arm.current.at, turnId, now) === 'stop') {
          disarm()
          stopNow.current()
          input.current?.focus({ preventScroll: true })
          return
        }
        clearTimeout(arm.current.timer)
        arm.current = { at: { turnId, at: now }, timer: setTimeout(disarm, ESC_WINDOW) }
        setArmed(true)
      },
    })
    return () => {
      off()
      disarm()
    }
  }, [stoppable, turnId, disarm])

  /**
   * macOS 上 Cmd+←/→ 跳到这一行（折行之后看到的那一行）的开头、结尾，带 Shift 是选到那里。
   * 不靠系统的按键绑定，自己按同样的规矩挪；Windows、Linux 照惯例是 Home/End，文本框自己就认
   */
  const lineJump = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (currentPlatform() !== 'mac' || !event.metaKey || event.ctrlKey || event.altKey) return false
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return false
    if (event.nativeEvent.isComposing || event.keyCode === 229) return false
    event.preventDefault()
    window
      .getSelection()
      ?.modify(
        event.shiftKey ? 'extend' : 'move',
        event.key === 'ArrowLeft' ? 'backward' : 'forward',
        'lineboundary',
      )
    return true
  }

  /**
   * 输入历史：光标在最前面时按上箭头，换成上一次发过的话，再按接着往前；下箭头往回，翻过头回到原来写了一半的字。
   * 光标不在最前面时上下箭头照常在多行文字里移动。动手改了字就不算在翻了。
   */
  const recall = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
    if (event.nativeEvent.isComposing || event.keyCode === 229) return false
    const up = event.key === 'ArrowUp'
    const state = recalling.current
    const area = event.currentTarget
    if (!state && !(up && area.selectionStart === 0 && area.selectionEnd === 0)) return false
    const sent = props.history?.() ?? []
    const back = (state?.back ?? 0) + (up ? 1 : -1)
    if (back > sent.length) return Boolean(state)
    event.preventDefault()
    if (back <= 0) {
      recalling.current = null
      setText(state?.draft ?? '')
      return true
    }
    recalling.current = { back, draft: state ? state.draft : text }
    setText(sent[sent.length - back] ?? '')
    return true
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 单子开着：上下键、回车、Tab、Esc 先归它
    if (suggest.onKeyDown(event)) return
    if (lineJump(event)) return
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && recall(event)) return
    if (event.key !== 'Enter' || event.shiftKey) return
    // 输入法还在选词：这个回车是确认候选，不是发送。229 是有些浏览器在组字期间报的键码
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    if (ready) send()
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = event.clipboardData
    const files = Array.from(data.files)
    const plain = tidyText(data.getData('text/plain'))
    // 从表格、文档里复制文字时，剪贴板里会顺带一张渲染出来的图：有字又有富文本，就按文字贴
    const rich = data.types.includes('text/html') || data.types.includes('text/rtf')
    if (files.length > 0 && !(rich && plain.trim())) {
      // 贴进来的是文件：图片加成附件，别的按文件带；不让文件名当成文字贴进来
      event.preventDefault()
      addFiles(files, false)
      return
    }
    // 贴进来的是文字：不长的照常进输入框；长的不塞进去，转成一片带着，发的时候并回正文
    const verdict = pasteVerdict(plain)
    if (verdict === 'inline') return
    event.preventDefault()
    if (verdict === 'long') {
      setError(t('composer.paste.long', { max: TEXT_LIMIT.toLocaleString(t.lang) }))
    } else if (extras.length >= EXTRAS_LIMIT) {
      setError(t('composer.extra.count', { max: EXTRAS_LIMIT }))
    } else {
      setExtras((current) => mergeExtras(current, [{ kind: 'text', name: null, text: plain }]))
      setError(null)
    }
  }

  /** 把带着的一段文字放回正文（接在打的字后面），那一片拿掉 */
  const inline = (index: number) => {
    const extra = extras[index]
    if (extra?.kind !== 'text') return
    const next = inlineText(text, extra)
    recalling.current = null
    landing.current = next.length
    setText(next)
    setExtras((current) => current.filter((_, at) => at !== index))
    input.current?.focus()
  }

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false)
  }
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event.dataTransfer)) return
    event.preventDefault()
    setDropping(false)
    addFiles(Array.from(event.dataTransfer.files), true)
  }

  const steer = (message: QueuedMessage) => {
    setError(null)
    onSteer?.(message.id).catch((reason: unknown) => {
      setError(t('composer.steerFailed', { reason: reasonOf(reason, t) }))
    })
  }

  /** 这一条现在插不进去：它带着图，而这个 harness 引导的时候带不了图 */
  const stuck = (message: QueuedMessage) => props.steerImages === false && message.images.length > 0

  const unqueue = (message: QueuedMessage, edit: boolean) => {
    onUnqueue?.(message.id)
    if (!edit) return
    setText((current) =>
      current && message.text ? `${current}\n${message.text}` : current || message.text,
    )
    setImages((current) => [...current, ...message.images].slice(0, MAX_IMAGES))
    setExtras((current) => mergeExtras(current, message.extras))
    input.current?.focus()
  }

  // 回合在跑、发出去插不进去（设置选了排队，或者插不了话）：发的东西排队。主按钮和评论的直接发送都按它写字
  const queuing = running === true && !props.steerNow
  // 有字、有图或带着东西的时候主按钮是发送（回合进行中就是排队）；什么都没写而回合在跑，主按钮是停止
  const mode = filled ? (queuing ? 'queue' : 'send') : running && onStop ? 'stop' : 'send'
  return (
    <>
      {queued.length > 0 ? (
        <ul className="tray" aria-label={t('composer.queued')}>
          {queued.map((message) => (
            <li key={message.id} className="tray-row">
              {message.extras.map((extra, index) =>
                // 提到的会话写在正文里，不另出一片
                extra.kind === 'session' ? null : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 贴进来的文字没有自己的标识，同一段可以带两遍
                  <span key={index} className="mention">
                    {labelOf(extra)}
                  </span>
                ),
              )}
              {message.images.length > 0 ? (
                <span className="mention">
                  {t('composer.imageCount', { n: message.images.length })}
                </span>
              ) : null}
              <span className="ell grow">{message.text}</span>
              {running && onSteer ? (
                // 带着图而图插不进去的那一条：留着能点，点了说为什么（等回合结束它会照常发出去）
                <button
                  type="button"
                  className="mini steer"
                  title={t(stuck(message) ? 'composer.steer.noImages' : 'composer.steer.note')}
                  aria-disabled={stuck(message) || undefined}
                  onClick={() =>
                    stuck(message) ? setError(t('composer.steer.noImages')) : steer(message)
                  }
                >
                  {t('composer.steer')}
                </button>
              ) : null}
              <button type="button" className="mini" onClick={() => unqueue(message, true)}>
                {t('composer.editQueued')}
              </button>
              <button
                type="button"
                className="ibtn"
                title={t('composer.unqueue')}
                aria-label={t('composer.unqueue')}
                onClick={() => unqueue(message, false)}
              >
                <Close />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 拖放没有键盘的对应操作，加附件另有按钮 */}
      <div
        className={dropping ? 'cmp dropping' : 'cmp'}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {suggest.popup}
        {images.length > 0 || chipped > 0 || comments.length > 0 ? (
          <ul className="cmp-atts" aria-label={t('composer.attached')}>
            {comments.map((comment, index) => (
              <CommentChip
                key={comment.id}
                comment={comment}
                n={index + 1}
                queue={queuing}
                onSave={(note) => updateComment(draftKey, comment.id, note)}
                onRemove={() => {
                  removeComment(draftKey, comment.id)
                  input.current?.focus()
                }}
                onSend={(note) => {
                  if (!sessionId) return
                  removeComment(draftKey, comment.id)
                  const one = { ...comment, note }
                  sendComment(channel, deviceId, sessionId, one, props.steerNow === true).catch(
                    (reason: unknown) => {
                      saveDraftComments(draftKey, [one, ...loadComments(draftKey)])
                      setError(t('composer.failed', { reason: reasonOf(reason, t) }))
                    },
                  )
                }}
                onLocate={
                  sessionId
                    ? () => void revealOrigin(replica.store, { deviceId, sessionId, ...comment })
                    : undefined
                }
              />
            ))}
            {extras.map((extra, index) =>
              // 提到的会话写在正文里（@[标题]），不另出一片：删掉那几个字就不带了
              extra.kind === 'session' ? null : (
                <ExtraChip
                  // biome-ignore lint/suspicious/noArrayIndexKey: 贴进来的文字没有自己的标识，同一段可以带两遍
                  key={index}
                  extra={extra}
                  onInline={() => inline(index)}
                  onRemove={() => {
                    setExtras((current) => current.filter((_, at) => at !== index))
                    input.current?.focus()
                  }}
                />
              ),
            )}
            {images.map((image, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 图片没有自己的标识，同一张图可以加两次
              <li key={index} className="cmp-att">
                <img
                  src={image.url}
                  alt={image.name ?? t('attachment.image')}
                  title={image.name ?? undefined}
                />
                <button
                  type="button"
                  className="cmp-att-x"
                  title={t('composer.image.remove')}
                  aria-label={t('composer.image.remove')}
                  onClick={() => setImages((current) => current.filter((_, at) => at !== index))}
                >
                  <Close />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="cmp-row">
          <textarea
            ref={input}
            className="cmp-text"
            rows={1}
            value={text}
            placeholder={props.placeholder}
            onChange={(event) => {
              recalling.current = null
              setText(event.target.value)
              suggest.typed(event.target.value, event.target.selectionStart)
            }}
            onSelect={(event) => {
              const area = event.currentTarget
              suggest.moved(area.selectionStart === area.selectionEnd ? area.selectionStart : null)
            }}
            onFocus={() => suggest.focus(true)}
            onBlur={() => suggest.focus(false)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>
        <div className="cmp-bar">
          <button
            type="button"
            className="ibtn"
            data-act="attach"
            // 能带什么写在按钮上：本机设备、外壳给得出路径时什么文件都能提到；否则只带得了图片和文本文件的内容
            title={t(
              !local
                ? 'composer.attach.remote'
                : window.litchShell
                  ? 'composer.attach'
                  : 'composer.attach.inline',
            )}
            aria-label={t('composer.attach')}
            onClick={() => picker.current?.click()}
          >
            <Clip />
          </button>
          <input
            ref={picker}
            type="file"
            hidden
            multiple
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []), true)
              // 清掉，不然同一个文件选第二次不会触发
              event.target.value = ''
            }}
          />
          {props.lead}
          <SettingsBar
            options={options}
            settings={props.settings}
            fresh={props.fresh}
            onChange={props.onSettings}
          />
          <span className="grow" />
          {armed ? (
            <span className="cmp-esc ell" role="status">
              {t('composer.escAgain')}
            </span>
          ) : null}
          <ContextMeter
            usage={props.usage ?? null}
            compact={props.compact}
            limits={props.harness ? { deviceId, harness: props.harness } : undefined}
          />
          {mode === 'stop' ? (
            <button
              type="button"
              className={armed ? 'send stop armed' : 'send stop'}
              title={t('composer.stopKeys')}
              aria-label={t('composer.stop')}
              onClick={stop}
            >
              <Stop />
            </button>
          ) : (
            <button
              type="button"
              className="send"
              title={t(mode === 'queue' ? 'composer.queue' : 'composer.send')}
              aria-label={t(mode === 'queue' ? 'composer.queue' : 'composer.send')}
              disabled={!ready}
              onClick={send}
            >
              <Send />
            </button>
          )}
        </div>
      </div>
      {props.below}
      {error || imagesRefused || blocked ? (
        <div className="cmp-hint err">
          {error ??
            (imagesRefused
              ? t(noImages ? 'composer.image.harness' : 'composer.image.unsupported')
              : blocked)}
        </div>
      ) : null}
    </>
  )
}

const NO_SETTINGS: SessionSettings = {
  model: null,
  effort: null,
  speed: null,
  permission: null,
  mode: null,
}
const NO_QUEUE: QueuedMessage[] = []

interface SessionComposerProps {
  deviceId: string
  sessionId: string
  blocked: string | null
}

/** 一个已有会话的输入区：消息发进这个会话，设置改的是这个会话的 */
export function SessionComposer({ deviceId, sessionId, blocked }: SessionComposerProps) {
  const { channel, replica } = useServices()
  const t = useT()
  const turnIds = useKey<string[]>(keys.turnIds(deviceId, sessionId))
  const last = turnIds?.[turnIds.length - 1] ?? ''
  const running = useKey<TurnView>(keys.turn(deviceId, sessionId, last))?.status === 'running'
  const queued = useKey<QueuedMessage[]>(keys.queued(deviceId, sessionId)) ?? NO_QUEUE
  const asking = (useKey<RequestView[]>(keys.requests(deviceId, sessionId))?.length ?? 0) > 0
  const settings = useKey<SessionSettings>(keys.settings(deviceId, sessionId)) ?? NO_SETTINGS
  const usage = useKey<ContextUsage | null>(keys.usage(deviceId, sessionId))
  const meta = useKey<SessionMeta>(keys.session(deviceId, sessionId))
  const can = meta?.can
  const able = can?.compact !== false
  // 它声明了不会压缩：不出这个入口。没有声明的照旧留着，对面说不认识了再停掉并写明原因
  const hidden = can?.declared === true && !able
  const compact = useMemo(
    () =>
      hidden
        ? undefined
        : {
            able,
            busy: running,
            run: () => channel.command('session.compact', { deviceId, sessionId }),
          },
    [channel, deviceId, sessionId, able, running, hidden],
  )

  // 回合进行中发的消息：设置里选的是立即发送、这个会话也插得了话就带 now 直接插进去，否则排队。
  // 带着图而这个 harness 引导时带不了图的，核心照常排着（插不进去不算没发成）
  const device = useKey<DeviceView>(keys.device(deviceId))
  const whenRunning = useRunningSend(can?.steer)
  const onSend = useCallback(
    (text: string, images: ImageAttachment[], extras: MessageExtra[]) => {
      // 差异面板里攒着的批注接在这条消息后面一起发；没发成就还回去（diff/annotations.ts）
      const notes = takeNotes(notesKey(deviceId, sessionId), noteWords(t))
      return channel
        .command('session.send', {
          deviceId,
          sessionId,
          text: withNotes(text, notes.text),
          images,
          extras,
          ...(whenRunning === 'steer' ? { now: true } : {}),
        })
        .catch((error: unknown) => {
          notes.restore()
          throw error
        })
    },
    [channel, deviceId, sessionId, t, whenRunning],
  )
  // 打的是 /goal 加上目标：设成持续目标，不当消息发（goal/send.ts）
  const sendOrGoal = useGoalSend(deviceId, sessionId, onSend)
  // 上一轮用的型号：会话打开时是它当时的设置，之后每开始一轮记一次。下一轮要换到别的供应商时提示一行
  const options = useComposeOptions(deviceId, meta?.harness)
  const [ranWith, setRanWith] = useState<{ sessionId: string; model: string | null } | null>(null)
  useEffect(() => {
    if (settings.model && ranWith?.sessionId !== sessionId)
      setRanWith({ sessionId, model: settings.model })
  }, [sessionId, settings.model, ranWith?.sessionId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在开始一轮的那一下记，跑着的时候换了型号算下一轮的
  useEffect(() => {
    if (running) setRanWith({ sessionId, model: settings.model })
  }, [running, sessionId])
  const switched =
    ranWith?.sessionId === sessionId
      ? switchedProvider(ranWith.model, settings.model, options?.models ?? [])
      : null
  // 输入历史就是这个会话里发过的话：不另外存，翻的时候从对话里现找
  const history = useCallback(() => {
    const { store } = replica
    const sent: string[] = []
    for (const turnId of store.get<string[]>(keys.turnIds(deviceId, sessionId)) ?? []) {
      const turn = store.get<TurnView>(keys.turn(deviceId, sessionId, turnId))
      for (const itemId of turn?.itemIds ?? []) {
        const item = store.get<ItemView>(keys.item(deviceId, sessionId, itemId))
        // 带评论的只算打的字（评论那一段不是用户自己写的）
        const said = commentsOf(item?.kind === 'userMessage' ? item.text : '')?.rest
        const words = said ?? (item?.kind === 'userMessage' ? item.text : '')
        if (!words.trim()) continue
        // 连着发了两遍一样的只算一条
        if (sent[sent.length - 1] !== words) sent.push(words)
      }
    }
    return sent
  }, [replica, deviceId, sessionId])
  return (
    <Composer
      deviceId={deviceId}
      sessionId={sessionId}
      harness={meta?.harness}
      draftKey={`${deviceId}:${sessionId}`}
      cwd={meta?.cwd ?? null}
      onNew={requestNewSession}
      placeholder={
        running
          ? t(runningPlaceholder(whenRunning), { harness: nameOf(device, meta?.harness ?? '') })
          : t('composer.placeholder')
      }
      blocked={blocked}
      lead={<PendingNotes deviceId={deviceId} sessionId={sessionId} />}
      below={
        switched ? (
          <div className="cmp-hint" data-provider-switch>
            {t(
              meta?.harness === 'claude-code'
                ? 'composer.providerSwitch.claude'
                : 'composer.providerSwitch',
              { name: switched },
            )}
          </div>
        ) : undefined
      }
      running={running}
      turnId={last}
      asking={asking}
      steerNow={whenRunning === 'steer'}
      queued={queued}
      settings={settings}
      usage={usage ?? null}
      {...(compact ? { compact } : {})}
      history={history}
      onSettings={(patch) => {
        channel
          .command('session.configure', { deviceId, sessionId, settings: patch })
          .catch(() => {})
      }}
      onSend={sendOrGoal}
      onStop={() => channel.command('session.interrupt', { deviceId, sessionId })}
      // 它不会引导（声明了不会，或者试过对面不认识）就没有“现在就说”，排着的等回合结束照常发
      {...(can?.steer === false
        ? {}
        : {
            onSteer: (messageId: string) =>
              channel.command('session.steer', { deviceId, sessionId, messageId }),
          })}
      steerImages={can?.steerImages !== false}
      onUnqueue={(messageId) => {
        channel.command('session.unqueue', { deviceId, sessionId, messageId }).catch(() => {})
      }}
    />
  )
}
