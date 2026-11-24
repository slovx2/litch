// 应用详情 · 私聊绑定：填对方私聊机器人拿到的配对码，查到后确认绑定；下面是已绑定和撤销过的人。
// 每人一行：名字（没有用 open_id）、创建者与已撤销标记、用户身份授权状态（失败、失效带原因）、绑定或撤销时间，
// 行尾审批人开关、私聊记录保留天数、授权或撤销授权、撤销绑定。授权的次要信息（授权时间、最近使用、权限数）在悬停里。
// 授权进行中时行下面一小行显示给本人的链接和用户码（都能复制）与有效期。发起授权、撤销授权都先确认。
// 已撤销的只能改保留天数。写操作都带 expectedRevision，冲突或绑定已在别处变了时重读这一应用的绑定并提示重试；
// 列表来自核心的 feishuBindings 快照（绑定连同授权），命令结果与重读到的先合进来（revision 大的为准），不等快照。
import { useCallback, useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { useNow } from '../app/clock.ts'
import { stamp, stampFull } from '../app/format.ts'
import { Ban, Icon, Key, KeyOff } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import { operationId } from '../external/model.ts'
import { Switch } from '../external/parts.tsx'
import { useFeishuBindings, useFeishuRun } from './data.ts'
import { grantDetailText, grantErrorText, grantLinkLeftText, grantStateText } from './grant-text.ts'
import {
  bindingIsCreator,
  bindingName,
  boundedInt,
  canInviteGrant,
  canRevokeGrant,
  FEISHU_RETENTION_DAYS,
  type FeishuApp,
  type FeishuBinding,
  type FeishuPairing,
  type FeishuUserGrant,
  GRANT_TONE,
  grantFor,
  grantLinkLive,
  grantShown,
  mergeBindings,
  mergeGrants,
  pairingCode,
  pairingCodeBad,
  sortBindings,
  timeLeft,
  userIdentityMissing,
  type WriteBlock,
} from './model.ts'
import { timeLeftText } from './speech-text.ts'

const TONE_PILL = { ok: 'pill ok', wait: 'pill wait', err: 'pill err', off: 'pill mute' } as const

/** 复制给本人的链接或用户码，复制后出一条提示 */
function copyText(text: string) {
  void navigator.clipboard?.writeText(text).then(
    () => showToast({ id: 'fs-grant-copy', lifeMs: 2000, text: (t) => t('feishu.grant.copied') }),
    () => {},
  )
}

/**
 * 授权进行中：给本人的链接和用户码（都能复制）与有效期，一行放下，窄了换行。
 * 链接不做成可点的：在这台电脑上打开会以 Litch 使用者的飞书账号同意，不是本人
 */
function GrantLink({ grant, now }: { grant: FeishuUserGrant; now: number }) {
  const t = useT()
  const pending = grant.pending
  if (!pending) return null
  const live = grantLinkLive(grant, now)
  return (
    <div
      className="fs-grant-link ext-row-meta"
      data-feishu-grant-link={grant.openId}
      title={t('feishu.grant.linkNote')}
    >
      <span className="fs-grant-field fs-grant-url">
        <span>{t('feishu.grant.link')}</span>
        <span className="mono ell" data-feishu-grant-url>
          {pending.verificationUrl.replace(/^https:\/\//u, '')}
        </span>
        <button
          type="button"
          className="ibtn"
          data-act="feishu-grant-copy-link"
          title={t('feishu.grant.copyLink')}
          aria-label={t('feishu.grant.copyLink')}
          onClick={() => copyText(pending.verificationUrl)}
        >
          <Icon name="copy" small />
        </button>
      </span>
      <span className="fs-grant-field">
        <span>{t('feishu.grant.code')}</span>
        <b className="mono fs-grant-code" data-feishu-grant-code>
          {pending.userCode}
        </b>
        <button
          type="button"
          className="ibtn"
          data-act="feishu-grant-copy-code"
          title={t('feishu.grant.copyCode')}
          aria-label={t('feishu.grant.copyCode')}
          onClick={() => copyText(pending.userCode)}
        >
          <Icon name="copy" small />
        </button>
      </span>
      <span
        className={live ? 'fs-nowrap' : 'fs-nowrap fs-grant-reason'}
        title={stampFull(pending.expiresAt * 1000, t.lang)}
      >
        {grantLinkLeftText(t, pending, now)}
      </span>
    </div>
  )
}

/** 保留天数：改完离开输入框或回车时提交；不合法的标红不提交，Esc 恢复原值 */
function RetentionInput({
  binding,
  disabled,
  title,
  onSave,
}: {
  binding: FeishuBinding
  disabled: boolean
  title: string | undefined
  onSave(days: number): void
}) {
  const t = useT()
  const [text, setText] = useState(String(binding.retentionDays))
  useEffect(() => setText(String(binding.retentionDays)), [binding.retentionDays])
  const days = boundedInt(text, FEISHU_RETENTION_DAYS)
  const range = t('feishu.chat.range', {
    min: FEISHU_RETENTION_DAYS.min,
    max: FEISHU_RETENTION_DAYS.max,
  })
  const commit = () => {
    if (days !== null && days !== binding.retentionDays) onSave(days)
  }
  return (
    <span className="fs-binding-days ext-row-meta">
      <span>{t('feishu.binding.keep')}</span>
      <input
        className={days === null ? 'req-input fs-days wrong' : 'req-input fs-days'}
        inputMode="numeric"
        value={text}
        disabled={disabled}
        aria-label={t('feishu.binding.retention')}
        title={days === null ? range : (title ?? t('feishu.binding.retention'))}
        data-feishu-binding-days={binding.openId}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape') {
            // 只恢复输入框，不让应用详情页把 Esc 当成返回
            event.preventDefault()
            setText(String(binding.retentionDays))
          }
        }}
      />
      <span>{t('feishu.binding.dayUnit')}</span>
    </span>
  )
}

export function AppBindings({
  deviceId,
  app,
  block,
}: {
  deviceId: string
  app: FeishuApp
  /** 写操作为什么不能做；null 是能做 */
  block: WriteBlock
}) {
  const t = useT()
  const now = useNow()
  const { channel } = useServices()
  const appId = app.appId
  const view = useFeishuBindings(deviceId, appId)
  /** 命令结果和冲突后重读到的绑定 */
  const [fresh, setFresh] = useState<FeishuBinding[]>([])
  /** 授权命令的结果和重读到的授权 */
  const [freshGrants, setFreshGrants] = useState<FeishuUserGrant[]>([])
  const refetch = useCallback(() => {
    channel.command('feishu.binding.list', { deviceId, appId }).then(
      (result) => setFresh(result.bindings),
      () => {},
    )
    channel.command('feishu.grant.list', { deviceId, appId }).then(
      (result) => setFreshGrants(result.grants),
      () => {},
    )
  }, [channel, deviceId, appId])
  const act = useFeishuRun(refetch)
  const grantAct = useFeishuRun(refetch, true)
  const find = useFeishuRun()
  const [code, setCode] = useState('')
  const [found, setFound] = useState<{ code: string; pairing: FeishuPairing } | null>(null)
  const [revoking, setRevoking] = useState<FeishuBinding | null>(null)
  /** 在确认发起授权的、在确认撤销授权的 */
  const [inviting, setInviting] = useState<FeishuBinding | null>(null)
  const [ungranting, setUngranting] = useState<FeishuBinding | null>(null)

  const keep = (binding: FeishuBinding) =>
    setFresh((list) => [...list.filter((one) => one.openId !== binding.openId), binding])
  const keepGrant = (grant: FeishuUserGrant) =>
    setFreshGrants((list) => [...list.filter((one) => one.openId !== grant.openId), grant])
  const latest = view?.value?.bindings ?? null
  const rows = latest ? sortBindings(mergeBindings(latest, fresh)) : null
  const grants = mergeGrants(view?.value?.grants ?? [], freshGrants)
  const denied =
    block === 'readOnly' ? t('feishu.readOnly') : block ? t('feishu.offline') : undefined
  const writable = block === null && !act.busy && !grantAct.busy
  const normalized = pairingCode(code)
  const bad = pairingCodeBad(code)
  const left = found ? timeLeft(found.pairing.expiresAt, now) : null

  const lookup = async () => {
    if (!normalized) return
    setFound(null)
    const result = await find.run(() =>
      channel.command('feishu.binding.lookup', { deviceId, appId, code: normalized }),
    )
    if (result) setFound({ code: normalized, pairing: result.pairing })
  }
  const approve = async () => {
    if (!found) return
    const result = await act.run(() =>
      channel.command('feishu.binding.approve', { deviceId, appId, code: found.code }),
    )
    if (!result) return
    keep(result.binding)
    setFound(null)
    setCode('')
  }
  const update = async (
    binding: FeishuBinding,
    patch: { approver?: boolean; retentionDays?: number },
  ) => {
    const result = await act.run(() =>
      channel.command('feishu.binding.update', {
        deviceId,
        appId,
        openId: binding.openId,
        expectedRevision: binding.revision,
        ...patch,
      }),
    )
    if (result) keep(result.binding)
  }
  const revoke = async (binding: FeishuBinding) => {
    setRevoking(null)
    const result = await act.run(() =>
      channel.command('feishu.binding.revoke', {
        deviceId,
        appId,
        openId: binding.openId,
        expectedRevision: binding.revision,
      }),
    )
    if (result) keep(result.binding)
  }

  const invite = async (binding: FeishuBinding) => {
    setInviting(null)
    const result = await grantAct.run(() =>
      channel.command('feishu.grant.invite', {
        deviceId,
        appId,
        openId: binding.openId,
        operationId: operationId(),
      }),
    )
    if (result) keepGrant(result.grant)
  }
  const ungrant = async (binding: FeishuBinding) => {
    setUngranting(null)
    const result = await grantAct.run(() =>
      channel.command('feishu.grant.revoke', { deviceId, appId, openId: binding.openId }),
    )
    if (result) keepGrant(result.grant)
  }

  const error = view?.error ?? null
  const pending = app.pendingPairings ?? 0
  return (
    <section className="ext-block" data-feishu-bindings>
      <div className="ext-block-head">
        <h3>{t('feishu.binding.title')}</h3>
        {pending > 0 ? (
          <span className="pill wait" data-feishu-pending-pairings>
            {t('feishu.binding.pending', { n: pending })}
          </span>
        ) : null}
      </div>
      <p className="fs-hint">{t('feishu.binding.note')}</p>
      <form
        className="fs-pair-find"
        onSubmit={(event) => {
          event.preventDefault()
          if (block === null && normalized && !find.busy) void lookup()
        }}
      >
        <input
          className={bad ? 'req-input mono fs-code wrong' : 'req-input mono fs-code'}
          value={code}
          placeholder="ABCD-EFGH"
          maxLength={12}
          autoComplete="off"
          spellCheck={false}
          aria-label={t('feishu.binding.code')}
          title={denied}
          disabled={block !== null}
          data-feishu-pairing-code
          onChange={(event) => {
            setCode(event.target.value)
            setFound(null)
            find.setError('')
          }}
        />
        <button
          type="submit"
          className="btn ghost"
          data-act="feishu-pairing-lookup"
          title={denied}
          disabled={block !== null || !normalized || find.busy}
        >
          {t('feishu.binding.lookup')}
        </button>
      </form>
      {block === 'readOnly' ? <p className="fs-hint">{t('feishu.readOnly')}</p> : null}
      {bad ? <p className="fs-hint err">{t('feishu.binding.codeBad')}</p> : null}
      {find.error ? (
        <p className="fs-hint err" role="alert" data-feishu-pairing-error>
          {find.error}
        </p>
      ) : null}
      {found ? (
        <div className="ext-detail fs-pairing" data-feishu-pairing={found.pairing.openId}>
          <div className="ext-row">
            <b className="ext-row-name ell">{bindingName(found.pairing)}</b>
            <span className="ext-row-meta mono ell">{found.pairing.openId}</span>
          </div>
          <div className="fs-inbox-meta ext-row-meta">
            <span title={stampFull(found.pairing.createdAt * 1000, t.lang)}>
              {t('feishu.binding.requested', {
                time: stamp(found.pairing.createdAt * 1000, now, t.lang),
              })}
            </span>
            <span className={left ? undefined : 'err'}>
              {left ? timeLeftText(t, left) : t('feishu.binding.expired')}
            </span>
          </div>
          <div className="ext-actions">
            <button
              type="button"
              className="btn primary"
              data-act="feishu-pairing-approve"
              title={denied}
              disabled={!writable || !left}
              onClick={() => void approve()}
            >
              {t('feishu.binding.approve')}
            </button>
            <button type="button" className="btn ghost" onClick={() => setFound(null)}>
              {t('feishu.cancel')}
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="devp-note err" role="alert">
          {error.text ? t.text(error.text) : error.message}
        </div>
      ) : null}
      {act.error ? (
        <div className="devp-note err" role="alert" data-feishu-binding-error>
          {act.error}
        </div>
      ) : null}
      {grantAct.error ? (
        <div className="devp-note err" role="alert" data-feishu-grant-error>
          {grantAct.error}
        </div>
      ) : null}
      {rows === null ? (
        error ? null : (
          <div className="ext-empty">{t('feishu.loading')}</div>
        )
      ) : rows.length === 0 ? (
        <div className="ext-empty">{t('feishu.binding.none')}</div>
      ) : (
        <ul className="ext-list">
          {rows.map((binding) => {
            const revoked = binding.state === 'revoked'
            const at = ((revoked ? binding.revokedAt : null) ?? binding.boundAt) * 1000
            // 撤销了绑定的人授权随之撤销，不再显示授权
            const grant = revoked ? null : grantFor(grants, binding.openId)
            const shown = grantShown(grant)
            const reason = revoked ? null : grantErrorText(t, grant)
            const grantTitle = [
              `${t('feishu.grant.label')} · ${grantStateText(t, grant)}`,
              reason,
              grantDetailText(t, grant, now),
            ]
              .filter(Boolean)
              .join('\n')
            return (
              <li
                key={binding.openId}
                className="fs-binding-item"
                data-feishu-binding={binding.openId}
                data-state={binding.state}
              >
                <div className="ext-row fs-binding" data-state={binding.state}>
                  <b className="ext-row-name ell" title={binding.openId}>
                    {bindingName(binding)}
                  </b>
                  {bindingIsCreator(binding, app) ? (
                    <span className="pill mute fs-nowrap">{t('feishu.binding.creator')}</span>
                  ) : null}
                  {revoked ? (
                    <span className="pill mute fs-nowrap">{t('feishu.binding.revoked')}</span>
                  ) : (
                    <span
                      className={`${TONE_PILL[GRANT_TONE[shown]]} fs-nowrap`}
                      data-feishu-grant={shown}
                      title={grantTitle}
                    >
                      {grantStateText(t, grant)}
                    </span>
                  )}
                  {reason ? (
                    <span
                      className="ext-row-meta fs-grant-reason ell"
                      data-feishu-grant-reason={grant?.error}
                      title={grantTitle}
                    >
                      {reason}
                    </span>
                  ) : null}
                  <span className="ext-row-meta fs-nowrap" title={stampFull(at, t.lang)}>
                    {t(revoked ? 'feishu.binding.revokedAt' : 'feishu.binding.boundAt', {
                      time: stamp(at, now, t.lang),
                    })}
                  </span>
                  {/* 开关、天数、授权、撤销放在一组里靠右，窄了整组换到下一行 */}
                  <span className="fs-binding-ctl">
                    {revoked ? null : (
                      <span className="fs-binding-approver ext-row-meta">
                        <span>{t('feishu.binding.approver')}</span>
                        <Switch
                          checked={binding.approver}
                          label={t('feishu.binding.approver')}
                          act="feishu-binding-approver"
                          disabled={!writable}
                          title={denied ?? t('feishu.binding.approverNote')}
                          onChange={(approver) => void update(binding, { approver })}
                        />
                      </span>
                    )}
                    <RetentionInput
                      binding={binding}
                      disabled={!writable}
                      title={denied}
                      onSave={(retentionDays) => void update(binding, { retentionDays })}
                    />
                    {revoked ? (
                      <span className="fs-binding-gap" aria-hidden="true" />
                    ) : canInviteGrant(grant, now) ? (
                      <button
                        type="button"
                        className="ibtn"
                        data-act="feishu-grant-invite"
                        title={denied ?? t('feishu.grant.invite')}
                        aria-label={t('feishu.grant.invite')}
                        disabled={!writable}
                        onClick={() => setInviting(binding)}
                      >
                        <Key />
                      </button>
                    ) : canRevokeGrant(grant) ? (
                      <button
                        type="button"
                        className="ibtn"
                        data-act="feishu-grant-revoke"
                        title={denied ?? t('feishu.grant.revoke')}
                        aria-label={t('feishu.grant.revoke')}
                        disabled={!writable}
                        onClick={() => setUngranting(binding)}
                      >
                        <KeyOff />
                      </button>
                    ) : (
                      <span className="fs-binding-gap" aria-hidden="true" />
                    )}
                    {revoked ? (
                      <span className="fs-binding-gap" aria-hidden="true" />
                    ) : (
                      <button
                        type="button"
                        className="ibtn"
                        data-act="feishu-binding-revoke"
                        title={denied ?? t('feishu.binding.revoke')}
                        aria-label={t('feishu.binding.revoke')}
                        disabled={!writable}
                        onClick={() => setRevoking(binding)}
                      >
                        <Ban />
                      </button>
                    )}
                  </span>
                </div>
                {grant?.pending ? <GrantLink grant={grant} now={now} /> : null}
              </li>
            )
          })}
        </ul>
      )}
      {revoking ? (
        <Confirm
          title={t('feishu.binding.revoke.title', { name: bindingName(revoking) })}
          note={t('feishu.binding.revoke.note')}
          yes={t('feishu.binding.revoke')}
          no={t('feishu.cancel')}
          onYes={() => void revoke(revoking)}
          onClose={() => setRevoking(null)}
        />
      ) : null}
      {inviting ? (
        <Confirm
          title={t('feishu.grant.invite.title', { name: bindingName(inviting) })}
          note={t('feishu.grant.invite.note', { name: bindingName(inviting) })}
          yes={t('feishu.grant.invite.yes')}
          no={t('feishu.cancel')}
          tone="primary"
          onYes={() => void invite(inviting)}
          onClose={() => setInviting(null)}
        >
          {userIdentityMissing(app.capability) ? (
            <p className="fs-hint err" data-feishu-grant-prereq>
              {t('feishu.grant.invite.prereq')}
            </p>
          ) : null}
        </Confirm>
      ) : null}
      {ungranting ? (
        <Confirm
          title={t('feishu.grant.revoke.title', { name: bindingName(ungranting) })}
          note={t('feishu.grant.revoke.note')}
          yes={t('feishu.grant.revoke')}
          no={t('feishu.cancel')}
          onYes={() => void ungrant(ungranting)}
          onClose={() => setUngranting(null)}
        />
      ) : null}
    </section>
  )
}
