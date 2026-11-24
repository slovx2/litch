// 应用详情 · 能力自检：上次检查的时间与结果、缺的权限 / 用户身份权限 / 事件 / 回调，
// 没开“刷新 user_access_token”单列一行，“检查”和“补申请”。用户身份缺的由补申请一并处理。
// 两样都只在用户点了才做（补申请会给企业管理员发审核通知）；补申请提交后显示待审核。
import { useT } from '../app/appearance.ts'
import { stamp } from '../app/format.ts'
import { Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { operationId } from '../external/model.ts'
import { Field } from '../external/parts.tsx'
import { type OnApp, useFeishuRun } from './data.ts'
import {
  canUpgrade,
  type FeishuApp,
  missingGroups,
  pendingReview,
  userIdentityMissing,
  type WriteBlock,
} from './model.ts'

const STATE_CLASS = {
  ok: 'pill ok',
  missing: 'pill wait',
  needs_self_manage: 'pill err',
  app_disabled: 'pill err',
  unknown: 'pill mute',
} as const

export function AppCapability({
  deviceId,
  app,
  block,
  onApp,
}: {
  deviceId: string
  app: FeishuApp
  /** 写操作为什么不能做（检查、补申请都只给管理员连接）；null 是能做 */
  block: WriteBlock
  onApp: OnApp
}) {
  const t = useT()
  const { channel } = useServices()
  const act = useFeishuRun()
  const denied = block === 'readOnly' ? t('feishu.readOnly') : undefined
  const capability = app.capability
  const check = async () => {
    const result = await act.run(() =>
      channel.command('feishu.app.check', { deviceId, appId: app.appId }),
    )
    if (result) onApp(result.app)
  }
  const upgrade = async () => {
    const result = await act.run(() =>
      channel.command('feishu.app.upgrade', {
        deviceId,
        appId: app.appId,
        operationId: operationId(),
      }),
    )
    if (result) onApp(result.app)
  }
  const state = capability?.state
  // 有原因要说的几种状态，整句放在下面；ok、missing 只出药丸
  const explained = state === 'needs_self_manage'
  return (
    <section className="ext-block" data-feishu-capability={state ?? 'never'}>
      <div className="ext-block-head">
        <h3>{t('feishu.cap.title')}</h3>
        {state && !explained ? (
          <span className={STATE_CLASS[state]}>{t(`feishu.cap.state.${state}`)}</span>
        ) : null}
        {pendingReview(capability) ? (
          <span className="pill wait" data-feishu-pending>
            {t('feishu.cap.pending')}
          </span>
        ) : null}
        <span className="grow" />
        <span className="ext-row-meta">
          {capability
            ? t('feishu.cap.checkedAt', {
                time: stamp(capability.checkedAt * 1000, Date.now(), t.lang),
              })
            : t('feishu.cap.never')}
        </span>
        <button
          type="button"
          className="ibtn"
          data-act="feishu-check"
          title={denied ?? t('feishu.cap.check')}
          aria-label={t('feishu.cap.check')}
          disabled={block !== null || act.busy}
          onClick={() => void check()}
        >
          <Icon name="reload" small />
        </button>
      </div>
      {explained ? (
        <div className="devp-note err">{t('feishu.cap.state.needs_self_manage')}</div>
      ) : null}
      {capability
        ? missingGroups(capability).map((group) => (
            <Field key={group.kind} label={t(`feishu.cap.${group.kind}`)}>
              <span className="ext-chips">
                {group.items.map((item) => (
                  <span key={item} className="pill mute mono">
                    {item}
                  </span>
                ))}
              </span>
            </Field>
          ))
        : null}
      {capability?.refreshTokenDisabled ? (
        <p className="fs-hint err" data-feishu-refresh-off>
          {t('feishu.cap.refreshToken')}
        </p>
      ) : null}
      {userIdentityMissing(capability) ? (
        <p className="fs-hint" data-feishu-user-note>
          {t('feishu.cap.userNote')}
        </p>
      ) : null}
      {canUpgrade(capability) ? (
        <div className="ext-actions">
          <span className="ext-row-meta grow">{t('feishu.cap.upgradeNote')}</span>
          <button
            type="button"
            className="btn"
            data-act="feishu-upgrade"
            title={denied}
            disabled={block !== null || act.busy}
            onClick={() => void upgrade()}
          >
            {t('feishu.cap.upgrade')}
          </button>
        </div>
      ) : null}
      {act.error ? (
        <div className="devp-note err" role="alert">
          {act.error}
        </div>
      ) : null}
    </section>
  )
}
