// 过程区里的步骤：推理、命令、改文件、工具调用这些过程性的条目。三级收纳：
// 步骤组一行灰色的汇总（两段说明之间连续的条目）→ 每个条目一行 → 条目的详情。每一级点一下展开。
import type {
  CommandItem,
  CompactionItem,
  FileChangeItem,
  ItemView,
  NoticeItem,
  ReasoningItem,
  RequestView,
  ToolCallItem,
  ToolPart,
  WebSearchItem,
} from '@litch/core'
import { keys, stepKindOf, stepsTally, thoughtShown } from '@litch/core'
import { Fragment, memo, type ReactNode, useContext, useMemo, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { useElapsed } from '../app/clock.ts'
import { duration, elapsed } from '../app/format.ts'
import { ImageViewer } from '../app/ImageViewer.tsx'
import { Caret, Icon, type IconName } from '../app/icons.tsx'
import { useKey, useKeys } from '../app/services.tsx'
import { openDiffAt } from '../diff/state.ts'
import { byteSize } from '../files/lines.ts'
import type { Translator } from '../i18n/index.ts'
import { openAgent } from '../tree/agents.ts'
import { commandLook, commandState } from './command-state.ts'
import { Diff } from './Diff.tsx'
import { ToolPath } from './FileLinks.tsx'
import { type ItemRef, sessionKeyOf, useItem } from './messages.tsx'
import { desktopSessionLink, PeerLinks } from './PeerHead.tsx'
import { usePin } from './scroll.ts'
import { seenSince, TurnTouch, useFold } from './state.ts'
import { messageTarget, nowOf, stepsSummary, suggestTitles } from './steps-text.ts'

interface RowProps {
  itemRef: ItemRef
  icon: IconName
  verb: string
  target: ReactNode
  meta?: ReactNode
  /** 还在进行：行首显示转动的记号 */
  busy?: boolean
  /** 没有详情的行不能点开 */
  detail?: (() => ReactNode) | null
  /** quiet：次要的浅色字（思考） */
  tone?: 'quiet'
}

/** 步骤组里的一行：动词、对象、右边的元信息；有详情时点一下展开 */
function Row({ itemRef, icon, verb, target, meta, busy, detail, tone }: RowProps) {
  const [open, setOpen] = useFold(sessionKeyOf(itemRef), `i:${itemRef.itemId}`, false)
  const head = useRef<HTMLButtonElement | null>(null)
  const pin = usePin()
  const touch = useContext(TurnTouch)
  return (
    <div className="item" data-tone={tone}>
      <button
        type="button"
        className="item-head"
        data-anchor={`i:${itemRef.itemId}`}
        ref={head}
        aria-expanded={detail ? open : undefined}
        disabled={!detail}
        onClick={() => {
          pin(head.current)
          if (!open) touch()
          setOpen(!open)
        }}
      >
        {busy ? <i className="st run" /> : <Icon name={icon} small />}
        {verb ? <span className="verb">{verb}</span> : null}
        <span className="tgt ell">{target}</span>
        {meta ? <span className="meta">{meta}</span> : null}
      </button>
      {open && detail ? <div className="item-detail">{detail()}</div> : null}
    </div>
  )
}

/** 固定高度的内滚框，内容增长时自己贴着底 */
function Well({ children }: { children: ReactNode }) {
  return (
    <div className="well">
      <pre>{children}</pre>
    </div>
  )
}

const firstLine = (text: string): string => text.split('\n', 1)[0] ?? ''

/**
 * 思考：一行次要的浅字（头一行），点开看全文；不写“想了一下”这类动词。
 * 没有可显示的字（引擎只给了加密的、空的推理）就不画（thoughtShown）。
 * 在想的时候只有运行记号和思考的字：“正在工作”只写在回合末尾那一行
 */
const Reasoning = memo(function Reasoning(ref: ItemRef) {
  const item = useItem<ReasoningItem>(ref)
  if (item?.kind !== 'reasoning' || !thoughtShown(item)) return null
  const text = item.text.trim()
  return (
    <Row
      itemRef={ref}
      icon="think"
      verb=""
      target={firstLine(text)}
      busy={item.status === 'inProgress'}
      tone="quiet"
      detail={text ? () => <div className="think">{text}</div> : null}
    />
  )
})

/**
 * 建议任务、收尾留的问题：卡片和问题画在回合最下方的收尾区，过程里它的位置只留这一行（建议的标题）
 */
const Suggest = memo(function Suggest(ref: ItemRef) {
  const item = useItem<ToolCallItem>(ref)
  const t = useT()
  if (item?.kind !== 'toolCall') return null
  const kind = stepKindOf(item)
  const n = item.wrapUp ? item.wrapUp.suggestions.length || 1 : 1
  return (
    <Row
      itemRef={ref}
      icon="suggest"
      verb={t(kind === 'ask' ? 'activity.ask' : 'activity.suggest', { n })}
      target={suggestTitles(item)}
      busy={item.status === 'inProgress'}
    />
  )
})

/**
 * 还在跑的命令右边那几个字。等批准的写“待审批”，不写“运行中”；
 * 看着它开始的带上已经跑了多久——对面不增量给输出的时候，这是唯一看得出它还活着的东西。
 * 单独一个组件：每秒重画的只有这几个字，命令结束了它就不在了。
 */
function Running({ item, deviceId, sessionId }: ItemRef & { item: CommandItem }) {
  const t = useT()
  const pending = useKey<RequestView[]>(keys.requests(deviceId, sessionId))
  const waiting =
    pending?.some((request) => request.kind === 'approval' && request.itemId === item.id) === true
  const spent = useElapsed(waiting ? null : item.startedAt)
  if (waiting) return <span data-state="waiting">{t('command.waiting')}</span>
  return (
    <>
      {spent === null || spent < 1000 ? null : <span data-elapsed="">{elapsed(spent, t)}</span>}
      <span>{t('command.running')}</span>
    </>
  )
}

/**
 * 命令的输出框。太长的输出核心只留了头尾（@litch/core 的 text/output-cap.mts）：
 * 省掉的地方单独占一行，写明省了多少。省略记号是块级的，头、尾各在自己的匿名块里排版；
 * 省过之后开头那段不再变，流式时每一帧变的只有末尾那段（至多几万个字），改它不牵动开头
 */
function OutputWell({ item }: { item: CommandItem }) {
  const t = useT()
  const { output, elided } = item
  return (
    <Well>
      {output}
      {elided ? (
        <>
          <span className="well-gap">{t('command.elided', { size: byteSize(elided.bytes) })}</span>
          {elided.tail}
        </>
      ) : null}
    </Well>
  )
}

const Command = memo(function Command(ref: ItemRef) {
  const item = useItem<CommandItem>(ref)
  const t = useT()
  if (item?.kind !== 'command') return null
  const shown = item.output !== '' || item.elided !== null
  const look = commandLook(item)
  return (
    <Row
      itemRef={ref}
      icon="term"
      verb={t('command.verb')}
      target={item.command}
      busy={item.status === 'inProgress'}
      meta={
        item.status === 'inProgress' ? (
          <Running {...ref} item={item} />
        ) : (
          <>
            {look.durationMs === null ? null : <span>{duration(look.durationMs, t)}</span>}
            <span className={look.failed ? 'minus' : undefined}>{commandState(item, t)}</span>
          </>
        )
      }
      detail={shown ? () => <OutputWell item={item} /> : null}
    />
  )
})

const baseName = (path: string): string => path.split(/[\\/]/).pop() || path

const FileChange = memo(function FileChange(ref: ItemRef) {
  const item = useItem<FileChangeItem>(ref)
  const t = useT()
  if (item?.kind !== 'fileChange') return null
  const { changes } = item
  const added = changes.reduce((sum, change) => sum + change.added, 0)
  const removed = changes.reduce((sum, change) => sum + change.removed, 0)
  const only = changes.length === 1 ? changes[0] : undefined
  return (
    <Row
      itemRef={ref}
      icon="edit"
      verb={t(only ? `change.${only.change}` : 'change.update')}
      target={
        only ? (
          <span title={only.path}>{baseName(only.path)}</span>
        ) : (
          t('change.files', { n: changes.length })
        )
      }
      busy={item.status === 'inProgress'}
      meta={
        <>
          {item.status === 'declined' ? <span>{t('status.declined')}</span> : null}
          {item.status === 'failed' ? <span className="minus">{t('status.failed')}</span> : null}
          <span className="plus">+{added}</span>
          <span className="minus">−{removed}</span>
        </>
      }
      detail={
        changes.length === 0
          ? null
          : () =>
              changes.map((change) => (
                <div key={change.path} className="file">
                  <div className="file-head">
                    <ToolPath className="ell" path={change.path} />
                    {change.movedTo ? <span className="ell">→ {change.movedTo}</span> : null}
                    <span className="meta">
                      <span className="plus">+{change.added}</span>
                      <span className="minus">−{change.removed}</span>
                      <button
                        type="button"
                        className="ibtn file-diff"
                        data-path={change.movedTo ?? change.path}
                        title={t('change.openDiff')}
                        aria-label={t('change.openDiff')}
                        onClick={() => openDiffAt(change.movedTo ?? change.path)}
                      >
                        <Icon name="diff" small />
                      </button>
                    </span>
                  </div>
                  <Diff change={change} />
                </div>
              ))
      }
    />
  )
})

/** 一段 blob 怎么叫 */
const BLOB_TEXT = {
  image: 'tool.blob.image',
  audio: 'tool.blob.audio',
  resource: 'tool.blob.resource',
  link: 'tool.blob.link',
  other: 'tool.blob.other',
} as const

/** 工具结果里省掉的地方那一行写什么：省掉的字有多大，一并省掉的图片之类有几段 */
function partsGap(part: Extract<ToolPart, { kind: 'gap' }>, t: Translator): string {
  const size = byteSize(part.bytes)
  if (part.parts === 0) return t('tool.elided', { size })
  if (part.bytes === 0) return t('tool.elidedBlobs', { n: part.parts })
  return t('tool.elidedBoth', { size, n: part.parts })
}

/**
 * 工具参数、结果的那一框。核心已经按段截好了（@litch/core 的 text/tool-cap.mts）：
 * 文字段原样，两段文字之间换一行；图片、音频、资源只有一行说明（块级，自己占一行），内容不显示；
 * 太长时中间省掉的地方一行记号，和命令输出的是同一种
 */
function PartsWell({ parts }: { parts: ToolPart[] }) {
  const t = useT()
  /** 正在看大图的那一张的地址 */
  const [viewing, setViewing] = useState<string | null>(null)
  return (
    <Well>
      {parts.map((part, index) => {
        if (part.kind === 'text') {
          const next = parts[index + 1]
          const text = next?.kind === 'text' ? `${part.text}\n` : part.text
          // biome-ignore lint/suspicious/noArrayIndexKey: 段只按先后排，整份一起换
          return <Fragment key={index}>{text}</Fragment>
        }
        if (part.kind === 'gap') {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 段只按先后排，整份一起换
            <span key={index} className="well-gap">
              {partsGap(part, t)}
            </span>
          )
        }
        const facts = [part.name, part.mime, part.bytes === null ? null : byteSize(part.bytes)]
        const label = [t(BLOB_TEXT[part.type]), ...facts.filter(Boolean)].join(' · ')
        if (part.src) {
          // 客户端工具的截图：固定大小的缩略图（解出来之前之后占的地方一样），点开看大图。
          // 一个条目至多几张留着内容（核心那边定的上限），再多的只有一行说明
          const src = part.src
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: 段只按先后排，整份一起换
              key={index}
              type="button"
              className="uimg well-img"
              title={label}
              aria-label={t('tool.image.view')}
              onClick={() => setViewing(src)}
            >
              <img src={src} alt={label} loading="lazy" decoding="async" />
            </button>
          )
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 段只按先后排，整份一起换
          <span key={index} className="well-blob" data-blob={part.type}>
            {label}
          </span>
        )
      })}
      {viewing ? (
        <ImageViewer url={viewing} label={t('tool.blob.image')} onClose={() => setViewing(null)} />
      ) : null}
    </Well>
  )
}

const ToolCall = memo(function ToolCall(ref: ItemRef) {
  const item = useItem<ToolCallItem>(ref)
  const t = useT()
  if (item?.kind !== 'toolCall') return null
  const { input, output } = item
  // 对面给的原话是截过的几段，按结果那样画；核心自己说的一句话照当前语言说
  const { error } = item
  const tool = t.text(item.tool)
  // 等待、发输入这些子代理调用（启动子代理那一次是露在外面的卡片）：涉及的子线程在详情里，点开在侧面板里看
  const agents = item.agents ?? []
  // 给别的会话、子代理发消息（“SendMessage 收件人”）：写成“发消息给 收件人”。收件方认出来是这台设备上的
  // Litch 会话、Claude 桌面端的会话时，详情最上面一行能点过去；收件箱地址照旧在参数里
  const message = stepKindOf(item) === 'message'
  const peer =
    message && (item.peer?.thread || desktopSessionLink(item.peer?.session ?? null))
      ? item.peer
      : undefined
  const hasDetail =
    input.length > 0 || output.length > 0 || error !== null || agents.length > 0 || !!peer
  return (
    <Row
      itemRef={ref}
      icon={message ? 'note' : 'tool'}
      verb={t(message ? 'tool.message.verb' : 'tool.verb')}
      target={
        message ? messageTarget(item, t) : item.source ? `${t.text(item.source)} · ${tool}` : tool
      }
      busy={item.status === 'inProgress'}
      meta={
        <>
          {item.durationMs === null ? null : <span>{duration(item.durationMs, t)}</span>}
          {item.status === 'failed' || error ? (
            <span className="minus">{t('status.failed')}</span>
          ) : null}
        </>
      }
      detail={
        hasDetail
          ? () => (
              <>
                {peer ? (
                  <div className="io">
                    <div className="io-label">{t('tool.message.to')}</div>
                    <div className="peer-to">
                      <span className="ell">{messageTarget(item, t)}</span>
                      <PeerLinks
                        deviceId={ref.deviceId}
                        peer={peer}
                        hints={{
                          litch: 'tool.message.openLitchHint',
                          desktop: 'tool.message.openHint',
                        }}
                      />
                    </div>
                  </div>
                ) : null}
                {agents.length > 0 ? (
                  <div className="io">
                    <div className="io-label">{t('info.agents')}</div>
                    <div className="tree-chips">
                      {agents.map((agent, index) => (
                        <button
                          key={agent.threadId}
                          type="button"
                          className="mini"
                          data-agent={agent.threadId}
                          title={t('tree.agent.open')}
                          onClick={() => openAgent(ref.deviceId, ref.sessionId, agent.threadId)}
                        >
                          {t('tree.agent.unnamed', { n: index + 1 })}
                          {agent.state ? ` · ${t(`tree.agent.${agent.state}`)}` : ''}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {input.length > 0 ? (
                  <div className="io">
                    <div className="io-label">{t('tool.args')}</div>
                    <PartsWell parts={input} />
                  </div>
                ) : null}
                {error !== null ? (
                  <div className="io">
                    <div className="io-label">{t('tool.error')}</div>
                    {Array.isArray(error) ? (
                      <PartsWell parts={error} />
                    ) : (
                      <Well>{t.text(error)}</Well>
                    )}
                  </div>
                ) : output.length > 0 ? (
                  <div className="io">
                    <div className="io-label">{t('tool.result')}</div>
                    <PartsWell parts={output} />
                  </div>
                ) : null}
              </>
            )
          : null
      }
    />
  )
})

const WebSearch = memo(function WebSearch(ref: ItemRef) {
  const item = useItem<WebSearchItem>(ref)
  const t = useT()
  if (item?.kind !== 'webSearch') return null
  return <Row itemRef={ref} icon="search" verb={t('search.verb')} target={item.query} />
})

const Notice = memo(function Notice(ref: ItemRef) {
  const item = useItem<NoticeItem>(ref)
  const t = useT()
  if (item?.kind !== 'notice') return null
  const detail = item.detail
  return (
    <Row
      itemRef={ref}
      icon="info"
      verb={t.text(item.label)}
      target=""
      detail={detail ? () => <div className="think">{detail}</div> : null}
    />
  )
})

/** 压了这么久还没完，后面加一句“可能要几分钟”（官方桌面端也是 10 秒） */
const COMPACTION_SLOW_MS = 10_000

/**
 * 上下文压缩：对话里一条分隔线，不收进过程。压的时候写“正在压缩上下文”，久了加一句可能要几分钟；
 * 压完写“上下文已压缩”（自动压的写“已自动压缩”），没压完回合就停了写“压缩已中断”
 */
export const Compaction = memo(function Compaction(ref: ItemRef) {
  const item = useItem<Extract<ItemView, CompactionItem>>(ref)
  const t = useT()
  const running = item?.kind === 'compaction' && item.status === 'inProgress'
  const spent = useElapsed(running ? (item.span?.from ?? null) : null)
  if (item?.kind !== 'compaction') return null
  const label = running
    ? t(spent !== null && spent >= COMPACTION_SLOW_MS ? 'compaction.slow' : 'compaction.running')
    : item.status === 'interrupted'
      ? t('compaction.interrupted')
      : t(item.source === 'manual' ? 'compaction.manual' : 'compaction.automatic')
  return (
    <div className="compaction" data-state={item.status} data-anchor={`i:${ref.itemId}`}>
      {running ? <i className="st run" /> : <Icon name="compact" small />}
      <span>{label}</span>
    </div>
  )
})

/** 只有提示的回合：提示直接露在外面，不收成汇总 */
export const Notes = memo(function Notes({
  deviceId,
  sessionId,
  itemIds,
}: {
  deviceId: string
  sessionId: string
  itemIds: string[]
}) {
  return (
    <div className="notes">
      {itemIds.map((itemId) => (
        <Notice key={itemId} deviceId={deviceId} sessionId={sessionId} itemId={itemId} />
      ))}
    </div>
  )
})

function StepItem({
  kind,
  suggest,
  ...ref
}: ItemRef & { kind: ItemView['kind']; suggest: boolean }) {
  switch (kind) {
    case 'reasoning':
      return <Reasoning {...ref} />
    case 'command':
      return <Command {...ref} />
    case 'fileChange':
      return <FileChange {...ref} />
    case 'toolCall':
      return suggest ? <Suggest {...ref} /> : <ToolCall {...ref} />
    case 'webSearch':
      return <WebSearch {...ref} />
    case 'notice':
      return <Notice {...ref} />
    default:
      return null
  }
}

const running = (item: ItemView): boolean => 'status' in item && item.status === 'inProgress'

/** 建议任务、收尾的问题那一行（卡片在收尾区） */
const isSuggest = (item: ItemView): boolean => {
  const kind = stepKindOf(item)
  return kind === 'suggest' || kind === 'ask'
}

/**
 * 正在跑的那一条已经跑了多久。等批准的命令写“待审批”，不计时（等人的时间不算它跑的）。
 * 单独一个组件：每秒重画的只有这几个字
 */
function NowTime({ item, deviceId, sessionId }: ItemRef & { item: ItemView }) {
  const t = useT()
  const pending = useKey<RequestView[]>(keys.requests(deviceId, sessionId))
  const waiting =
    pending?.some((request) => request.kind === 'approval' && request.itemId === item.id) === true
  const since = seenSince(
    `${deviceId}:${sessionId}:${item.id}`,
    item.kind === 'command' ? item.startedAt : null,
  )
  const spent = useElapsed(waiting ? null : since)
  if (waiting) return <span data-state="waiting">{t('command.waiting')}</span>
  return spent === null || spent < 1000 ? null : <span data-elapsed="">{elapsed(spent, t)}</span>
}

interface StepsProps {
  deviceId: string
  sessionId: string
  /** 组里第一个条目的标识 */
  groupKey: string
  itemIds: string[]
  /** 回合还在跑：组里有在跑的条目时，汇总行换成“正在做什么” */
  live: boolean
}

/**
 * 步骤组：一行灰色的汇总，默认收着，正在跑的时候也不自动展开。
 * 汇总写动作和个数；右边是被拒的个数（红字）、改动行数、这一组从第一条开始到最后一条结束的用时。
 * 失败的条数不写（每条命令自己的退出码照写）。正在跑时左边是运行记号，写当前这一条和计时。
 * 没字的思考不画、不算；只剩有字的思考的组不收成汇总，每条思考直接是一行浅字
 */
export const Steps = memo(function Steps({
  deviceId,
  sessionId,
  groupKey,
  itemIds,
  live,
}: StepsProps) {
  const sessionKey = sessionKeyOf({ deviceId, sessionId })
  const [open, setOpen] = useFold(sessionKey, `g:${groupKey}`, false)
  const touch = useContext(TurnTouch)
  const head = useRef<HTMLButtonElement | null>(null)
  const pin = usePin()
  const t = useT()
  const itemKeys = useMemo(
    () => itemIds.map((itemId) => keys.item(deviceId, sessionId, itemId)),
    [deviceId, sessionId, itemIds],
  )
  const values = useKeys<ItemView>(itemKeys)
  const items = useMemo(
    () => values.filter((value): value is ItemView => value !== undefined),
    [values],
  )
  const tally = useMemo(() => stepsTally(items), [items])
  const current = live ? items.findLast(running) : undefined
  const now = current ? nowOf(current, stepKindOf(current), t) : null
  const shown = items.filter(thoughtShown)
  // 什么都不剩（只有想完了、没字的思考）：不占地方
  if (!current && shown.length === 0) return null
  // 只有思考：不收成“想了一下”，每条一行浅字，点开看全文
  if (!current && shown.every((item) => item.kind === 'reasoning')) {
    return (
      <div className="steps thoughts" data-anchor={`g:${groupKey}`}>
        {shown.map((item) => (
          <Reasoning key={item.id} deviceId={deviceId} sessionId={sessionId} itemId={item.id} />
        ))}
      </div>
    )
  }
  return (
    <div className="steps" data-running={current ? '' : undefined}>
      <button
        type="button"
        className="steps-head"
        data-anchor={`g:${groupKey}`}
        ref={head}
        aria-expanded={open}
        onClick={() => {
          pin(head.current)
          if (!open) touch()
          setOpen(!open)
        }}
      >
        {now ? <i className="st run" /> : <Caret />}
        <span className="sum">{now ? now.label : stepsSummary(tally, t)}</span>
        {now?.target ? <span className="now ell">{now.target}</span> : null}
        <span className="meta">
          {tally.declined > 0 ? (
            <span className="bad">{t('activity.declined', { n: tally.declined })}</span>
          ) : null}
          {now || tally.added + tally.removed === 0 ? null : (
            <span>
              <span className="plus">+{tally.added}</span>
              <span className="minus">−{tally.removed}</span>
            </span>
          )}
          {current ? (
            <NowTime deviceId={deviceId} sessionId={sessionId} itemId={current.id} item={current} />
          ) : tally.durationMs ? (
            <span>{duration(tally.durationMs, t)}</span>
          ) : null}
        </span>
      </button>
      {open ? (
        <div className="steps-body">
          {shown.map((item) => (
            <StepItem
              key={item.id}
              deviceId={deviceId}
              sessionId={sessionId}
              itemId={item.id}
              kind={item.kind}
              suggest={isSuggest(item)}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
})
