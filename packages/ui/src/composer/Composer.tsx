import {
  type ContextUsage,
  type DeviceView,
  type ImageAttachment,
  type ItemView,
  keys,
  type MessageExtra,
  pathTwin,
  type QueuedMessage,
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
import { reasonOf } from '../app/errors.ts'
import { Clip, Close, Send, Stop } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import { notesKey, takeNotes, withNotes } from '../diff/annotations.ts'
import { noteWords, PendingNotes } from '../diff/Notes.tsx'
import { ExtraChip, useExtraLabel } from './Chips.tsx'
import { type Compaction, ContextMeter } from './ContextMeter.tsx'
import {
  dropDraft,
  insertIntoDraft,
  joinDraft,
  loadDraft,
  loadDraftExtras,
  loadDraftImages,
  mentionText,
  onMention,
  onRefill,
  saveDraft,
  saveDraftExtras,
  saveDraftImages,
} from './drafts.ts'
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
import { SettingsBar, useComposeOptions } from './SettingsBar.tsx'
import { useSuggest } from './useSuggest.tsx'

interface ComposerProps {
  deviceId: string
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
  /** 有回合在进行：这时发的消息会排队，没字的时候主按钮是停止 */
  running: boolean
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
  const { deviceId, draftKey, blocked, running, queued, onSend, onStop, onUnqueue } = props
  const { failure, onSteer } = props
  const t = useT()
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
  const device = useKey<DeviceView>(keys.device(deviceId))
  // 别处往输入框里加一样东西（文件面板的“加入对话”）：变成带着的一片，焦点回到输入框。
  // 带了行号的片上放不下，写成字插在光标那里。文件和工作目录可能是同一个目录的两种写法（pathTwin）
  const cwd = props.cwd ?? null
  const os = device?.os
  useEffect(
    () =>
      onMention((mention) => {
        const area = input.current
        if (!area) return
        recalling.current = null
        if (!mention.line) {
          setExtras((current) => mergeExtras(current, [fileExtra(mention, cwd, pathTwin(os))]))
          requestAnimationFrame(() => area.focus())
          return
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
      }),
    [cwd, os],
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
  const filled = text.trim().length > 0 || images.length > 0 || extras.length > 0
  const ready = filled && !blocked && !busy && !imagesRefused

  const suggest = useSuggest({
    deviceId,
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
        room: EXTRAS_LIMIT - extras.length,
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

  const send = useCallback(() => {
    const content = text.trim()
    const attached = images
    const carried = extras
    if (!content && attached.length === 0 && carried.length === 0) return
    // 先清空：消息已经显示在对话里了。没发成功再把文字、图片和附带项还回来
    recalling.current = null
    setText('')
    setImages([])
    setExtras([])
    dropDraft(draftKey)
    setError(null)
    setBusy(true)
    onSend(content, attached, carried)
      .catch((reason: unknown) => {
        setText((current) => (current && content ? `${content}\n${current}` : content || current))
        setImages((current) => [...attached, ...current].slice(0, MAX_IMAGES))
        setExtras((current) => mergeExtras(carried, current))
        const why = reasonOf(reason, t)
        setError(failure ? failure(why) : t('composer.failed', { reason: why }))
      })
      .finally(() => setBusy(false))
  }, [onSend, failure, draftKey, text, images, extras, t])

  const stop = () => {
    setError(null)
    onStop?.().catch((reason: unknown) => {
      setError(t('composer.interruptFailed', { reason: reasonOf(reason, t) }))
    })
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

  // 有字、有图或带着东西的时候主按钮是发送（回合进行中就是排队）；什么都没写而回合在跑，主按钮是停止
  const mode = filled ? (running ? 'queue' : 'send') : running && onStop ? 'stop' : 'send'
  return (
    <>
      {queued.length > 0 ? (
        <ul className="tray" aria-label={t('composer.queued')}>
          {queued.map((message) => (
            <li key={message.id} className="tray-row">
              {message.extras.map((extra, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 贴进来的文字没有自己的标识，同一段可以带两遍
                <span key={index} className="mention">
                  {labelOf(extra)}
                </span>
              ))}
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
        {images.length > 0 || extras.length > 0 ? (
          <ul className="cmp-atts" aria-label={t('composer.attached')}>
            {extras.map((extra, index) => (
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
            ))}
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
          <ContextMeter usage={props.usage ?? null} compact={props.compact} />
          {mode === 'stop' ? (
            <button
              type="button"
              className="send stop"
              title={t('composer.stop')}
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

const NO_SETTINGS: SessionSettings = { model: null, effort: null, permission: null, mode: null }
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
        })
        .catch((error: unknown) => {
          notes.restore()
          throw error
        })
    },
    [channel, deviceId, sessionId, t],
  )
  // 输入历史就是这个会话里发过的话：不另外存，翻的时候从对话里现找
  const history = useCallback(() => {
    const { store } = replica
    const sent: string[] = []
    for (const turnId of store.get<string[]>(keys.turnIds(deviceId, sessionId)) ?? []) {
      const turn = store.get<TurnView>(keys.turn(deviceId, sessionId, turnId))
      for (const itemId of turn?.itemIds ?? []) {
        const item = store.get<ItemView>(keys.item(deviceId, sessionId, itemId))
        if (item?.kind !== 'userMessage' || !item.text.trim()) continue
        // 连着发了两遍一样的只算一条
        if (sent[sent.length - 1] !== item.text) sent.push(item.text)
      }
    }
    return sent
  }, [replica, deviceId, sessionId])
  return (
    <Composer
      deviceId={deviceId}
      harness={meta?.harness}
      draftKey={`${deviceId}:${sessionId}`}
      cwd={meta?.cwd ?? null}
      onNew={requestNewSession}
      placeholder={t(running ? 'composer.placeholderRunning' : 'composer.placeholder')}
      blocked={blocked}
      lead={<PendingNotes deviceId={deviceId} sessionId={sessionId} />}
      running={running}
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
      onSend={onSend}
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
