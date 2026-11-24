// 接入一个群 / 改一个已接入群的设置（同一个对话框）：发言模式（不预选，外部群预选审批并要再勾确认）、
// 叫醒名单（成员选择器加“包括已绑定用户”）、保留天数、审批过期时间（只在审批发言时出）。
// 新接入提交全部设置；已接入的只提交改了的字段。机器人不在群里或群已解散时成员选择器不可用，其余照样能改。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Close, Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { Switch } from '../external/parts.tsx'
import { ChatRecords } from './ChatRecords.tsx'
import { type OnChat, useFeishuRun } from './data.ts'
import {
  accessParams,
  boundedInt,
  type ChatDraft,
  chatChanges,
  chatDraft,
  chatUnavailable,
  draftProblems,
  FEISHU_BACKFILL_LIMIT,
  FEISHU_RETENTION_DAYS,
  FEISHU_REVIEW_TTL_HOURS,
  FEISHU_WAKERS_MAX,
  type FeishuChat,
  type FeishuMember,
  type FeishuSpeechMode,
  memberChoices,
  toggleWaker,
  type WriteBlock,
} from './model.ts'

const SPEECH: FeishuSpeechMode[] = ['free', 'approval']

/** 一个群的标记：外部群、已解散、机器人已不在群里 */
export function ChatMarks({ chat }: { chat: FeishuChat }) {
  const t = useT()
  const unavailable = chatUnavailable(chat)
  return (
    <>
      {chat.external ? (
        <span className="pill mute" data-feishu-external>
          {t('feishu.chats.external')}
        </span>
      ) : null}
      {unavailable === 'dissolved' ? (
        <span className="pill mute">{t('feishu.chats.dissolved')}</span>
      ) : unavailable === 'botLeft' ? (
        <span className="pill wait">{t('feishu.chats.botLeft')}</span>
      ) : null}
    </>
  )
}

/** 成员选择器：打开时读一次成员，可搜、可多选，到上限后没勾的不能再勾 */
function Members({
  deviceId,
  chat,
  wakers,
  disabled,
  onChange,
}: {
  deviceId: string
  chat: FeishuChat
  wakers: ChatDraft['wakers']
  disabled: boolean
  onChange(wakers: ChatDraft['wakers']): void
}) {
  const t = useT()
  const { channel } = useServices()
  const unavailable = chatUnavailable(chat)
  const [members, setMembers] = useState<FeishuMember[] | null>(null)
  const [query, setQuery] = useState('')
  const load = useFeishuRun()
  const { appId, chatId } = chat
  const fetchMembers = useCallback(
    async (refresh: boolean) => {
      const result = await load.run(() =>
        channel.command('feishu.chat.members', {
          deviceId,
          appId,
          chatId,
          ...(refresh ? { refresh: true } : {}),
        }),
      )
      if (result) setMembers(result.members)
    },
    [load.run, channel, deviceId, appId, chatId],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在打开时、群可用时读一次
  useEffect(() => {
    if (!unavailable) void fetchMembers(false)
  }, [])
  const choices = memberChoices(unavailable ? null : members, wakers, query)
  const chosen = new Set(wakers.map((one) => one.openId))
  const full = wakers.length >= FEISHU_WAKERS_MAX
  const locked = disabled || unavailable !== null
  return (
    <div className="fs-members" data-feishu-members>
      {unavailable ? (
        <span className="fs-hint err">{t(`feishu.chat.unavailable.${unavailable}`)}</span>
      ) : (
        <div className="fs-members-head">
          <input
            className="req-input fs-members-search"
            type="search"
            value={query}
            placeholder={t('feishu.chat.members.search')}
            aria-label={t('feishu.chat.members.search')}
            data-feishu-member-search
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className="ibtn"
            data-act="feishu-members-refresh"
            title={t('feishu.chat.members.refresh')}
            aria-label={t('feishu.chat.members.refresh')}
            disabled={load.busy}
            onClick={() => void fetchMembers(true)}
          >
            <Icon name="reload" small />
          </button>
        </div>
      )}
      <fieldset className="fs-members-list" aria-label={t('feishu.chat.wakers')}>
        {members === null && !unavailable && load.busy ? (
          <span className="fs-hint">{t('feishu.chat.members.loading')}</span>
        ) : null}
        {load.error ? <span className="fs-hint err">{load.error}</span> : null}
        {choices.map(({ person, listed }) => {
          const checked = chosen.has(person.openId)
          return (
            <label key={person.openId} className="form-check" data-feishu-member={person.openId}>
              <input
                type="checkbox"
                checked={checked}
                disabled={locked || (full && !checked)}
                onChange={() => onChange(toggleWaker(wakers, person))}
              />
              <span className="ell">{person.name || person.openId}</span>
              {listed ? null : (
                <span className="pill mute">{t('feishu.chat.members.unlisted')}</span>
              )}
            </label>
          )
        })}
        {choices.length === 0 && (members !== null || unavailable !== null) ? (
          <span className="fs-hint">
            {query ? t('feishu.chat.members.noMatch') : t('feishu.chat.members.empty')}
          </span>
        ) : null}
      </fieldset>
      <span className="fs-hint" data-feishu-member-count>
        {t('feishu.chat.members.count', { count: wakers.length, max: FEISHU_WAKERS_MAX })}
        {full ? ` · ${t('feishu.chat.members.full', { max: FEISHU_WAKERS_MAX })}` : ''}
      </span>
    </div>
  )
}

/** 一个整数输入：名字、输入框、说明，填坏了说范围 */
function Bounded({
  label,
  note,
  value,
  range,
  disabled,
  field,
  onChange,
}: {
  label: string
  note: string
  value: string
  range: { readonly min: number; readonly max: number }
  disabled: boolean
  field: string
  onChange(value: string): void
}) {
  const t = useT()
  const bad = boundedInt(value, range) === null
  return (
    <label className="fs-form-row">
      <span>{label}</span>
      <input
        className={bad ? 'req-input fs-num wrong' : 'req-input fs-num'}
        inputMode="numeric"
        value={value}
        disabled={disabled}
        data-feishu-field={field}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className={bad ? 'fs-hint err' : 'fs-hint'}>
        {bad ? t('feishu.chat.range', { min: range.min, max: range.max }) : note}
      </span>
    </label>
  )
}

export function ChatDialog({
  deviceId,
  chat,
  block,
  onChat,
  onConflict,
  onUnaccess,
  onClose,
}: {
  deviceId: string
  chat: FeishuChat
  block: WriteBlock
  onChat: OnChat
  /** 版本冲突或接入状态已变：重读这个群 */
  onConflict(): void
  /** 已接入的群点了“取消接入”：由列表开确认框 */
  onUnaccess(): void
  onClose(): void
}) {
  const t = useT()
  const { channel } = useServices()
  const dialog = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState<ChatDraft>(() => chatDraft(chat))
  const act = useFeishuRun(onConflict)
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])
  const set = (patch: Partial<ChatDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const access = chat.access
  const name = chat.name || chat.chatId
  const writable = block === null && !act.busy
  const problems = draftProblems(draft, chat)
  const changes = access ? chatChanges(draft, access) : null
  // 机器人不在群里或群已解散：不能新接入（留着记录的群也能打开看）
  const closed = !access && chatUnavailable(chat) !== null
  const ready =
    writable &&
    !closed &&
    problems.length === 0 &&
    (changes === null || Object.keys(changes).length > 0)

  const submit = async () => {
    if (!ready) return
    let result: { chat: FeishuChat } | undefined
    if (access && changes) {
      result = await act.run(() =>
        channel.command('feishu.chat.update', {
          deviceId,
          appId: chat.appId,
          chatId: chat.chatId,
          expectedRevision: chat.revision,
          ...changes,
        }),
      )
    } else {
      const params = accessParams(draft, chat)
      if (!params) return
      result = await act.run(() => channel.command('feishu.chat.access', { deviceId, ...params }))
    }
    if (!result) return
    onChat(result.chat)
    onClose()
  }

  // 还不能提交的原因里，表单上看不出来的那几样写在底部
  const why = closed
    ? t('feishu.chat.unavailableAccess')
    : problems.includes('speech')
      ? t('feishu.chat.problem.speech')
      : problems.includes('external')
        ? t('feishu.chat.problem.external')
        : problems.includes('wakers')
          ? t('feishu.chat.problem.wakers', { max: FEISHU_WAKERS_MAX })
          : ''
  return (
    <dialog
      ref={dialog}
      className="modal ext-dialog fs-chat-dialog"
      aria-label={t(access ? 'feishu.chat.settingsTitle' : 'feishu.chat.accessTitle', { name })}
      data-feishu-chat-dialog={access ? 'settings' : 'access'}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="modal-head">
          <span className="grow ell">
            {t(access ? 'feishu.chat.settingsTitle' : 'feishu.chat.accessTitle', { name })}
          </span>
          <ChatMarks chat={chat} />
          <button
            type="button"
            className="ibtn"
            title={t('feishu.close')}
            aria-label={t('feishu.close')}
            onClick={onClose}
          >
            <Close />
          </button>
        </div>
        <div className="modal-body">
          {block === 'readOnly' ? <div className="modal-note">{t('feishu.readOnly')}</div> : null}
          {block === 'offline' ? <div className="modal-note">{t('feishu.offline')}</div> : null}
          <fieldset className="form-field fs-speech" disabled={block !== null}>
            <legend className="form-label">{t('feishu.chat.speech')}</legend>
            {SPEECH.map((mode) => (
              <label key={mode} className="form-check fs-speech-opt">
                <input
                  type="radio"
                  name="feishu-speech"
                  value={mode}
                  data-feishu-speech={mode}
                  checked={draft.speech === mode}
                  onChange={() => set({ speech: mode })}
                />
                <span>{t(`feishu.chat.speech.${mode}`)}</span>
                <span className="fs-hint">{t(`feishu.chat.speech.${mode}Note`)}</span>
              </label>
            ))}
          </fieldset>
          {!access && chat.external ? (
            <label className="form-check fs-external">
              <input
                type="checkbox"
                data-feishu-confirm-external
                checked={draft.confirmExternal}
                disabled={block !== null}
                onChange={(event) => set({ confirmExternal: event.target.checked })}
              />
              {t('feishu.chat.confirmExternal')}
            </label>
          ) : null}
          <div className="form-field">
            <span className="form-label">{t('feishu.chat.wakers')}</span>
            <span className="fs-hint">{t('feishu.chat.wakersNote')}</span>
            <span className="form-check">
              <Switch
                checked={draft.wakeBound}
                label={t('feishu.chat.wakeBound')}
                act="feishu-wake-bound"
                disabled={block !== null}
                onChange={(wakeBound) => set({ wakeBound })}
              />
              {t('feishu.chat.wakeBound')}
            </span>
            <Members
              deviceId={deviceId}
              chat={chat}
              wakers={draft.wakers}
              disabled={block !== null}
              onChange={(wakers) => set({ wakers })}
            />
          </div>
          <div className="fs-pair">
            <Bounded
              label={t('feishu.chat.retention')}
              note={t('feishu.chat.retentionNote')}
              value={draft.retentionDays}
              range={FEISHU_RETENTION_DAYS}
              disabled={block !== null}
              field="retention"
              onChange={(retentionDays) => set({ retentionDays })}
            />
            {draft.speech === 'approval' ? (
              <Bounded
                label={t('feishu.chat.ttl')}
                note={t('feishu.chat.ttlNote')}
                value={draft.reviewTtlHours}
                range={FEISHU_REVIEW_TTL_HOURS}
                disabled={block !== null}
                field="ttl"
                onChange={(reviewTtlHours) => set({ reviewTtlHours })}
              />
            ) : null}
          </div>
          {access ? null : (
            <span className="fs-hint">
              {t('feishu.chat.backfillNote', { max: FEISHU_BACKFILL_LIMIT })}
            </span>
          )}
          <ChatRecords deviceId={deviceId} chat={chat} block={block} onChat={onChat} />
          {act.error ? (
            <div className="modal-note err" role="alert" data-feishu-chat-error>
              {act.error}
            </div>
          ) : null}
        </div>
        <div className="modal-foot">
          {access ? (
            <button
              type="button"
              className="btn danger"
              data-act="feishu-unaccess"
              disabled={!writable}
              title={block === 'readOnly' ? t('feishu.readOnly') : undefined}
              onClick={onUnaccess}
            >
              {t('feishu.chat.unaccess')}
            </button>
          ) : null}
          <span className="grow fs-why" data-feishu-why>
            {block === null ? why : ''}
          </span>
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('feishu.cancel')}
          </button>
          <button
            type="submit"
            className="btn primary"
            data-act={access ? 'feishu-chat-save' : 'feishu-chat-access'}
            disabled={!ready}
            title={block === 'readOnly' ? t('feishu.readOnly') : undefined}
          >
            {t(access ? 'feishu.chat.save' : 'feishu.chat.access')}
          </button>
        </div>
      </form>
    </dialog>
  )
}
