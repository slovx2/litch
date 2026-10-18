// 活动区：推理、命令、改文件、工具调用这些过程性的条目。三级收纳：
// 一行总结（整个活动块）→ 每个条目一行 → 条目的详情。每一级点一下展开。
import type {
  AgentMessageItem,
  CommandItem,
  FileChangeItem,
  ItemView,
  NoticeItem,
  ReasoningItem,
  RequestView,
  ToolCallItem,
  ToolPart,
  WebSearchItem,
} from '@litch/core'
import { keys } from '@litch/core'
import { Fragment, memo, type ReactNode, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { useElapsed } from '../app/clock.ts'
import { duration, elapsed } from '../app/format.ts'
import { ImageViewer } from '../app/ImageViewer.tsx'
import { Caret, Icon, type IconName } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import { openDiffAt } from '../diff/state.ts'
import { byteSize } from '../files/lines.ts'
import type { Translator } from '../i18n/index.ts'
import { openAgent } from '../tree/agents.ts'
import { commandLook, commandState } from './command-state.ts'
import { Diff } from './Diff.tsx'
import { ToolPath } from './FileLinks.tsx'
import { Markdown } from './Markdown.tsx'
import { type ItemRef, sessionKeyOf, useItem } from './messages.tsx'
import { usePin } from './scroll.ts'
import { useToggle } from './state.ts'

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
}

/** 活动区里的一行：动词、对象、右边的元信息；有详情时点一下展开 */
function Row({ itemRef, icon, verb, target, meta, busy, detail }: RowProps) {
  const [open, setOpen] = useToggle(sessionKeyOf(itemRef), `i:${itemRef.itemId}`, false)
  const head = useRef<HTMLButtonElement | null>(null)
  const pin = usePin()
  return (
    <div className="item">
      <button
        type="button"
        className="item-head"
        data-anchor={`i:${itemRef.itemId}`}
        ref={head}
        aria-expanded={detail ? open : undefined}
        disabled={!detail}
        onClick={() => {
          pin(head.current)
          setOpen(!open)
        }}
      >
        {busy ? <i className="st run" /> : <Icon name={icon} small />}
        <span className="verb">{verb}</span>
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

const Reasoning = memo(function Reasoning(ref: ItemRef) {
  const item = useItem<ReasoningItem>(ref)
  const t = useT()
  if (item?.kind !== 'reasoning') return null
  const text = item.text
  return (
    <Row
      itemRef={ref}
      icon="think"
      verb={t(item.status === 'inProgress' ? 'reasoning.running' : 'reasoning.done')}
      target={firstLine(text)}
      busy={item.status === 'inProgress'}
      detail={text ? () => <div className="think">{text}</div> : null}
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
          <span className="well-gap" title={t('command.elidedWhy')}>
            {t('command.elided', { size: byteSize(elided.bytes) })}
          </span>
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
            <span key={index} className="well-gap" title={t('tool.elidedWhy')}>
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
  const hasDetail = input.length > 0 || output.length > 0 || error !== null || agents.length > 0
  return (
    <Row
      itemRef={ref}
      icon="tool"
      verb={t('tool.verb')}
      target={item.source ? `${t.text(item.source)} · ${tool}` : tool}
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

/** 只有说明的回合：说明直接露在外面，不带“活动”那一行折叠 */
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
    <div className="act-body notes">
      {itemIds.map((itemId) => (
        <Notice key={itemId} deviceId={deviceId} sessionId={sessionId} itemId={itemId} />
      ))}
    </div>
  )
})

/** 夹在过程中间的说明文字（过程说明阶段的助手消息）：直接按正文画，不折叠 */
const Commentary = memo(function Commentary(ref: ItemRef) {
  const item = useItem<AgentMessageItem>(ref)
  if (item?.kind !== 'agentMessage') return null
  return (
    <div className="item note">
      <Markdown
        text={item.text}
        streaming={item.status === 'inProgress'}
        anchor={`i:${ref.itemId}`}
      />
    </div>
  )
})

function ActivityItem({ kind, ...ref }: ItemRef & { kind: ItemView['kind'] }) {
  switch (kind) {
    case 'reasoning':
      return <Reasoning {...ref} />
    case 'command':
      return <Command {...ref} />
    case 'fileChange':
      return <FileChange {...ref} />
    case 'toolCall':
      return <ToolCall {...ref} />
    case 'webSearch':
      return <WebSearch {...ref} />
    case 'notice':
      return <Notice {...ref} />
    case 'agentMessage':
      return <Commentary {...ref} />
    default:
      return null
  }
}

interface ActivityProps {
  deviceId: string
  sessionId: string
  /** 活动块的标识：组里第一个条目的标识 */
  blockKey: string
  items: { itemId: string; kind: ItemView['kind'] }[]
  /** 该不该自动收起：回合结束了，或者后面已经有写完的最终回答 */
  settled: boolean
}

/** 活动块：进行中展开，告一段落后收成一行，可以再点开。用户点过就以用户的为准 */
export const Activity = memo(function Activity({
  deviceId,
  sessionId,
  blockKey,
  items,
  settled,
}: ActivityProps) {
  const [open, setOpen] = useToggle(`${deviceId}:${sessionId}`, `g:${blockKey}`, !settled)
  const head = useRef<HTMLButtonElement | null>(null)
  const pin = usePin()
  const t = useT()
  return (
    <div className="act">
      <button
        type="button"
        className="act-head"
        data-anchor={`g:${blockKey}`}
        ref={head}
        aria-expanded={open}
        onClick={() => {
          pin(head.current)
          setOpen(!open)
        }}
      >
        <Caret />
        <span>{t('activity.title')}</span>
        <span className="mono dim">{t('activity.steps', { n: items.length })}</span>
      </button>
      {open ? (
        <div className="act-body">
          {items.map((item) => (
            <ActivityItem key={item.itemId} deviceId={deviceId} sessionId={sessionId} {...item} />
          ))}
        </div>
      ) : null}
    </div>
  )
})
