// 对话流里的提案卡片（建议任务）：模型调 litch_sessions.start 降成提案的那一条画成一张卡片；
// 收尾调用（litch_sessions.wrap_up）带的建议每条一张，照建议的顺序排，被拒的那条只写一行原因。
// 收尾带的画在回合最下方的收尾区（TurnTail.tsx），过程里调用的位置只留一行；start 降成的提案露在调用的位置。
// 标题、harness、模型、目录、简报（长的可展开）、状态（等开始、已开始、在这里做、不要了、撤回了、过期了），
// 沙箱收不紧时的提醒；等着的有“开始”“在这里做”“改了再开始”“不要”，开始了的能点进子会话。
// 右上角“···”菜单里一项“在 {设备} 上对 {harness} 关闭任务卡”（task-cards.ts）。
// 状态取这个会话的提案列表（连了结的一起），对不上的再看侧栏里哪个子会话记着从这张提案开始。
// 开始了的写实际起出来的子会话的 harness、目录（proposalShape），不是提案原本的。
// 侧面板“建议任务”里的每一行用的是同一套按钮（ProposalActs）。
import {
  type DeviceView,
  keys,
  type ProposalShape,
  type ProposalStarts,
  proposalShape,
  proposalStatus,
  type SessionProposalView,
  type SessionSummary,
  type ToolCallItem,
  type WrapUpSuggestionView,
} from '@litch/core'
import { type ComponentType, useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { badgeOf, nameOf } from '../app/device.ts'
import { Icon, More } from '../app/icons.tsx'
import { usePopover } from '../app/popover.ts'
import { useKey, useServices } from '../app/services.tsx'
import { submitQuestionOnEnter } from '../manager/post-presentation.ts'
import { useOpenSession } from '../transcript/actions.tsx'
import { CardMarkdown } from '../transcript/CardMarkdown.tsx'
import type { ItemRef } from '../transcript/messages.tsx'
import { useToggle } from '../transcript/state.ts'
import { useWorktreesOn, WorktreeCheck } from '../worktrees/WorktreeCheck.tsx'
import { ModelLimitNotice } from './ModelLimitNotice.tsx'
import { proposalSummary } from './proposal-brief.ts'
import { withProposalNote } from './proposal-operation.ts'
import { STATUS_TEXT, useProposalAct, useProposalClock, useProposalList } from './proposals.ts'
import { SpawnDialog } from './SpawnDialog.tsx'
import { SANDBOX_LEVEL } from './sandbox.ts'
import { markOf } from './TreeCards.tsx'
import { turnOffTaskCards } from './task-cards.ts'
import { useProposalWorktree } from './useProposalWorktree.ts'

/**
 * “开始”“在这里做”“改了再开始”“不要”四个按钮，和没做成时的那句话。卡片和侧面板共用。
 * “在这里做”：“在这里做：标题”加任务当用户的话进这个会话的输入队列，回合在跑就排到回合后（同 Claude 桌面端）
 */
export function ProposalActs({
  deviceId,
  sessionId,
  proposal,
  small,
  inbox,
  noteFold,
  moreMenu,
  sourceParent,
}: {
  deviceId: string
  sessionId: string
  proposal: SessionProposalView
  small?: boolean
  inbox?: boolean
  /** 经理看板里：补充说明默认收起，点“补充说明”展开（同决策卡） */
  noteFold?: boolean
  /** 经理看板里：“编辑后开始”“忽略”收进行尾的“⋯”（同手机），一行放得下 */
  moreMenu?: boolean
  sourceParent?: Pick<SessionSummary, 'id' | 'title' | 'harness' | 'cwd' | 'workspaceId'>
}) {
  const t = useT()
  const { channel } = useServices()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const parent = useKey<SessionSummary>(keys.summary(deviceId, sessionId)) ?? sourceParent
  const act = useProposalAct(deviceId, sessionId, proposal.id)
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState('')
  const [noteOpen, setNoteOpen] = useState(false)
  const noteFocus = useRef(false)
  const noteShown = !noteFold || noteOpen || note !== ''
  // 卡上的工作树开关为准：设备按经理设置或普通会话规则给初值，用户仍可修改。
  const [worktree, setWorktree] = useState(proposal.worktree ?? proposal.worktreeDefault)
  const worktrees = useWorktreesOn(deviceId)
  const worktreeBlock = useProposalWorktree(
    channel,
    deviceId,
    sessionId,
    proposal.id,
    worktrees && worktree,
  )
  const off = act.busy || device?.connection !== 'online'
  const start = () => {
    if (off || worktreeBlock) return
    void act.accept(withProposalNote(proposal.prompt, note, worktrees ? { worktree } : {}))
  }
  return (
    <>
      {noteShown ? (
        <textarea
          ref={(box) => {
            // 点“补充说明”展开后直接进入输入
            if (!box || !noteFocus.current) return
            noteFocus.current = false
            box.focus()
          }}
          className="req-input prop-note"
          aria-label={t('proposal.note')}
          placeholder={t('proposal.note')}
          rows={2}
          value={note}
          disabled={off}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (!submitQuestionOnEnter(event.nativeEvent)) return
            event.preventDefault()
            start()
          }}
        />
      ) : null}
      <div className="prop-acts" data-small={small === true}>
        <button
          type="button"
          className="btn primary"
          data-act="start"
          disabled={off || worktreeBlock !== null}
          onClick={start}
        >
          {t(act.starting ? 'proposal.starting' : 'proposal.start')}
        </button>
        {!proposal.sourceIsManager ? (
          <button
            type="button"
            className="btn ghost"
            data-act="here"
            disabled={off}
            onClick={() => act.here()}
          >
            {t(inbox ? 'suggestions.here' : 'proposal.here')}
          </button>
        ) : null}
        {moreMenu ? null : (
          <>
            <button
              type="button"
              className="btn ghost"
              data-act="edit"
              // 弹窗要父会话的摘要（harness、项目、标题）
              disabled={off || !parent}
              onClick={() => setEditing(true)}
            >
              {t('proposal.edit')}
            </button>
            <button
              type="button"
              className="btn ghost"
              data-act="dismiss"
              disabled={off}
              onClick={() => act.dismiss()}
            >
              {t('proposal.dismiss')}
            </button>
          </>
        )}
        {noteShown ? null : (
          <button
            type="button"
            className="btn ghost"
            data-act="note-open"
            disabled={off}
            onClick={() => {
              noteFocus.current = true
              setNoteOpen(true)
            }}
          >
            {t('manager.addNote')}
          </button>
        )}
        <WorktreeCheck
          deviceId={deviceId}
          checked={worktree}
          disabled={off}
          onChange={setWorktree}
        />
        {moreMenu ? (
          <ProposalMore
            editDisabled={off || !parent}
            dismissDisabled={off}
            onEdit={() => setEditing(true)}
            onDismiss={() => act.dismiss()}
          />
        ) : null}
      </div>
      {worktreeBlock ? <p className="prop-err err">{t(worktreeBlock)}</p> : null}
      {act.limit ? (
        <ModelLimitNotice
          limit={act.limit}
          busy={off}
          onUseModel={({ harness, model }) =>
            void act.accept(
              withProposalNote(proposal.prompt, note, {
                ...(worktrees ? { worktree } : {}),
                harness,
                model,
                modelSelected: true,
              }),
            )
          }
        />
      ) : act.failure ? (
        <p className="prop-err err" role="alert">
          {act.failure}
        </p>
      ) : null}
      {act.retry ? (
        <button type="button" className="btn" disabled={off} onClick={() => act.retry?.()}>
          {t('proposal.retry')}
        </button>
      ) : null}
      {editing && parent ? (
        <SpawnDialog
          deviceId={deviceId}
          parent={parent}
          proposal={proposal}
          initialNote={note}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  )
}

/** 卡片上那一排小字：harness、模型、目录、全新还是带上下文。开始了的写的是实际起出来的子会话。offer 卡也用 */
export function ProposalMeta({ deviceId, shape }: { deviceId: string; shape: ProposalShape }) {
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const { harness, model, effort, cwd, kind } = shape
  return (
    <span
      className="prop-meta"
      data-actual={shape.actual}
      title={shape.actual ? t('proposal.actual') : undefined}
    >
      {harness ? (
        <span className="chip" title={nameOf(device, harness, t)}>
          {badgeOf(device, harness)}
        </span>
      ) : null}
      {harness ? <span data-harness={harness}>{nameOf(device, harness, t)}</span> : null}
      {model ? <span className="mono">{model}</span> : null}
      {effort ? (
        <span className="mono" data-effort={effort}>
          {effort}
        </span>
      ) : null}
      {cwd ? (
        <span className="mono ell prop-cwd" title={cwd}>
          {cwd}
        </span>
      ) : null}
      <span className="pill mute">{t(kind === 'fork' ? 'proposal.fork' : 'proposal.fresh')}</span>
    </span>
  )
}

/** 默认只显示背景首句，完整背景和任务按需挂载；看板保留其编号链接渲染。 */
export function Brief({
  prompt,
  background = '',
  expanded = false,
  renderText: Markdown = CardMarkdown,
}: {
  prompt: string
  background?: string
  expanded?: boolean
  renderText?: ComponentType<{ text: string }>
}) {
  const t = useT()
  const [open, setOpen] = useState(expanded)
  useEffect(() => {
    if (expanded) setOpen(true)
  }, [expanded])
  const context = background.trim()
  if (!prompt && !context) return null
  return (
    <>
      <p className="prop-brief prop-summary" data-part="summary">
        {proposalSummary(context, prompt)}
      </p>
      <button
        type="button"
        className="prop-more"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t(open ? 'proposal.brief.less' : 'proposal.brief.more')}
      </button>
      {open ? (
        <div className="prop-full-brief">
          {context ? (
            <div className="prop-brief" data-open="true" data-part="background" data-md="">
              <span className="prop-brief-label">{t('proposal.brief.background')}</span>
              <Markdown text={context} />
            </div>
          ) : null}
          <div className="prop-brief" data-open="true" data-part="task" data-md="">
            <span className="prop-brief-label">{t('proposal.brief.task')}</span>
            <Markdown text={prompt} />
          </div>
        </div>
      ) : null}
    </>
  )
}

/** 卡片照着画的那一份：调用时给的（start 的参数、收尾里的一条建议），拿不到提案时就照它 */
type ProposalSeed = Pick<
  SessionProposalView,
  'title' | 'prompt' | 'background' | 'harness' | 'model' | 'effort' | 'cwd' | 'kind'
>

/**
 * 一张提案卡片。proposalId 是空串：收尾的结果还没回来，只照建议画、不写状态。
 * anchor：卡片自己就是那一条工具调用（start 的那种），滚动定位、侧面板找卡片的标记打在卡片上
 */
function ProposalView({
  deviceId,
  sessionId,
  proposalId,
  seed,
  anchor,
}: {
  deviceId: string
  sessionId: string
  proposalId: string
  seed: ProposalSeed
  anchor?: string
}) {
  const t = useT()
  const list = useProposalList(deviceId, sessionId)
  const now = useProposalClock(list)
  const proposal = proposalId ? list?.find((entry) => entry.id === proposalId) : undefined
  const starts = useKey<ProposalStarts>(keys.proposalStarts(deviceId))
  const parent = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const childId = proposal?.startedId ?? (proposalId ? starts?.[proposalId] : undefined) ?? ''
  const child = useKey<SessionSummary>(keys.summary(deviceId, childId))
  // 列表里没有这一张（对面没给、或者还没取到）：照调用时给的画，开始了的看侧栏
  const status = proposal
    ? proposalStatus(proposal, now)
    : childId
      ? 'started'
      : list === undefined || !proposalId
        ? null
        : 'unknown'
  const [searchOpen] = useToggle(`${deviceId}:${sessionId}`, `search-brief:${anchor ?? ''}`, false)
  const title = proposal?.title ?? seed.title
  const prompt = proposal?.prompt ?? seed.prompt
  const background = proposal ? proposal.background : seed.background
  const shape = proposalShape(
    proposal ?? seed,
    status === 'started' ? child : null,
    parent?.harness ?? null,
  )
  const pending = status === 'pending' && proposal !== undefined
  return (
    <div
      className="tree-card prop-card"
      data-card="proposal"
      data-proposal={proposalId}
      data-item={anchor}
      data-search-item={anchor}
      data-state={status ?? ''}
      data-anchor={anchor ? `x:${anchor}` : undefined}
    >
      <div className="prop-body">
        <span className="tree-card-kind">
          <Icon name="suggest" small />
          <span className="grow">{t('proposal.kind')}</span>
          {status ? (
            <span className="prop-state">
              {t(status === 'unknown' ? 'proposal.state.unknown' : STATUS_TEXT[status])}
            </span>
          ) : null}
          <CardMenu deviceId={deviceId} sessionId={sessionId} />
        </span>
        <b className="prop-title">{title}</b>
        <ProposalMeta deviceId={deviceId} shape={shape} />
        <Brief prompt={prompt} background={background} expanded={searchOpen} />
        {pending && proposal.widerSandbox ? (
          <p className="prop-wider" data-wider={proposal.widerSandbox}>
            {t('proposal.wider', { level: t(SANDBOX_LEVEL[proposal.widerSandbox]) })}
          </p>
        ) : null}
        {pending ? (
          <ProposalActs deviceId={deviceId} sessionId={sessionId} proposal={proposal} />
        ) : null}
      </div>
      {status === 'started' && childId ? (
        <StartedChild deviceId={deviceId} childId={childId} title={title} />
      ) : null}
    </div>
  )
}

/** 看板建议卡行尾的“⋯”：编辑后开始、忽略。往上弹、靠右，不压到下面的卡外 */
function ProposalMore({
  editDisabled,
  dismissDisabled,
  onEdit,
  onDismiss,
}: {
  editDisabled: boolean
  dismissDisabled: boolean
  onEdit(): void
  onDismiss(): void
}) {
  const t = useT()
  const { open, setOpen, root, trigger, pop, onKeyDown } = usePopover()
  const pick = (run: () => void) => () => {
    setOpen(false)
    run()
  }
  return (
    <span className="prop-more-acts" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="ibtn"
        data-act="proposal-more"
        title={t('proposal.more')}
        aria-label={t('proposal.more')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <More />
      </button>
      {open ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: 键盘事件是从里面的按钮冒上来的
        <div className="pick-pop" ref={pop} onKeyDown={onKeyDown}>
          <div role="menu" aria-label={t('proposal.more')} className="pick-list">
            <button
              type="button"
              role="menuitem"
              className="pick-opt"
              data-act="edit"
              disabled={editDisabled}
              onClick={pick(onEdit)}
            >
              {t('proposal.edit')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="pick-opt"
              data-act="dismiss"
              disabled={dismissDisabled}
              onClick={pick(onDismiss)}
            >
              {t('proposal.dismiss')}
            </button>
          </div>
        </div>
      ) : null}
    </span>
  )
}

/**
 * 卡片右上角的“···”：一项“在 {设备} 上对 {harness} 关闭任务卡”，点了直接关、底部出可撤销的提示，卡片本身留着。
 * harness 是这个会话的（任务卡开关管的是哪个 harness 的会话出卡），不是提案要开在哪个 harness 上
 */
function CardMenu({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useT()
  const { channel, replica } = useServices()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const harness = useKey<SessionSummary>(keys.summary(deviceId, sessionId))?.harness
  const { open, setOpen, root, trigger, pop, onKeyDown } = usePopover()
  const [busy, setBusy] = useState(false)
  if (!device || !harness) return null
  const label = t('proposal.cardsOff', {
    device: t.text(device.name),
    harness: nameOf(device, harness, t),
  })
  return (
    <span className="prop-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="ibtn"
        data-act="more"
        title={t('proposal.more')}
        aria-label={t('proposal.more')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <More />
      </button>
      {open ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: 键盘事件是从里面的按钮冒上来的
        <div className="pick-pop down end" ref={pop} onKeyDown={onKeyDown}>
          <div role="menu" aria-label={t('proposal.more')} className="pick-list">
            <button
              type="button"
              role="menuitem"
              className="pick-opt"
              data-option="cardsOff"
              // 开关存在设备上：设备要连着、有设置接口
              disabled={busy || device.connection !== 'online' || !device.manageable}
              onClick={() => {
                setOpen(false)
                setBusy(true)
                void turnOffTaskCards(channel, replica, device, harness).finally(() =>
                  setBusy(false),
                )
              }}
            >
              <b>{label}</b>
            </button>
          </div>
        </div>
      ) : null}
    </span>
  )
}

/** 开始了的卡片下面那一行：起出来的子会话，点了进去。offer 卡也用 */
export function StartedChild({
  deviceId,
  childId,
  title,
}: {
  deviceId: string
  childId: string
  /** 子会话不在侧栏、没有标题时写的 */
  title: string
}) {
  const t = useT()
  const open = useOpenSession()
  const child = useKey<SessionSummary>(keys.summary(deviceId, childId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  return (
    <button
      type="button"
      className="prop-child"
      data-child={childId}
      disabled={!child || !open}
      title={t('tree.child.open')}
      onClick={() => open?.({ deviceId, sessionId: childId })}
    >
      <i className={`st ${markOf(child?.status)}`} />
      <span className="ell grow">
        {child ? t.text(child.title) || title : t('tree.child.gone')}
      </span>
      {child ? (
        <span className="chip" title={nameOf(device, child.harness, t)}>
          {badgeOf(device, child.harness)}
        </span>
      ) : null}
      {child ? <span className="tree-card-state">{t(`tree.status.${child.status}`)}</span> : null}
    </button>
  )
}

/** litch_sessions.start 降成提案的那一条 */
export function ProposalCard({
  deviceId,
  sessionId,
  itemId,
  item,
}: ItemRef & { item: ToolCallItem }) {
  const spawned = item.spawned
  if (!spawned) return null
  return (
    <ProposalView
      deviceId={deviceId}
      sessionId={sessionId}
      proposalId={spawned.proposalId ?? ''}
      seed={spawned}
      anchor={itemId}
    />
  )
}

/** 收尾里没收下的一条建议：卡片的位置上只写一行，标题和设备进程说的原因 */
function RefusedLine({ suggestion }: { suggestion: WrapUpSuggestionView }) {
  const t = useT()
  const reason = suggestion.refused ?? ''
  return (
    <div className="prop-refused" data-card="refused" title={reason || undefined}>
      <Icon name="suggest" small />
      <b className="ell prop-refused-title">{suggestion.title}</b>
      <span className="ell grow prop-refused-why">
        {reason ? t('proposal.refused', { reason }) : t('proposal.refusedBare')}
      </span>
    </div>
  )
}

/** litch_sessions.wrap_up 带了建议的那一条：照建议的顺序每条一张卡片（空的那种核心说不画，到不了这里） */
export function WrapUpCards({
  deviceId,
  sessionId,
  itemId,
  item,
}: ItemRef & { item: ToolCallItem }) {
  const suggestions = item.wrapUp?.suggestions ?? []
  if (suggestions.length === 0) return null
  return (
    <div className="wrap-cards" data-card="wrap-up" data-item={itemId} data-anchor={`x:${itemId}`}>
      {suggestions.map((suggestion, index) =>
        suggestion.refused !== null ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 建议的顺序就是它的身份，没有别的标识
          <RefusedLine key={index} suggestion={suggestion} />
        ) : (
          <ProposalView
            // biome-ignore lint/suspicious/noArrayIndexKey: 同上；有了提案号也不换 key，免得卡片重建
            key={index}
            deviceId={deviceId}
            sessionId={sessionId}
            proposalId={suggestion.proposalId ?? ''}
            seed={suggestion}
          />
        ),
      )}
    </div>
  )
}
