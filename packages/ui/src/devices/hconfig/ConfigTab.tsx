// 配置这一块：按对面声明的分组摆配置项，每组后面是这一组的动作（清空记忆之类，要先确认的先问）。
// 一项一行：标题、改了之后怎么生效、说明、被更高一层盖住时实际生效的值、只读的原因、默认值、控件、恢复默认。
// 改过的攒在一起保存（全有或全无）；版本对不上时核心已经重读，改动留着，提示看着最新的再保存。
// 别处改了这一块（收到通知、重读了），手上又有没保存的改动：提示一句，可以保留自己的、或者用最新的。
import type {
  ChannelErrorShape,
  DeviceView,
  HcAction,
  HcConfigView,
  HcSettingSpec,
  HcSlot,
  HcValue,
} from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { Confirm } from '../../app/Confirm.tsx'
import { whyNot } from '../../app/errors.ts'
import { useLeaveGuard } from '../../app/leave-guard.tsx'
import { useServices } from '../../app/services.tsx'
import { showToast } from '../../app/toasts.tsx'
import { HcControl, isWide, useHcValueText } from './HcControl.tsx'
import { effectKey, type HcDraft, type Parsed, parseDraft, sameAsStored } from './logic.ts'
import { SlotState } from './parts.tsx'

interface ConfigTabProps {
  device: DeviceView
  harnessId: string
  slot: HcSlot<HcConfigView>
}

export function ConfigTab({ device, harnessId, slot }: ConfigTabProps) {
  const t = useT()
  const { channel } = useServices()
  const [drafts, setDrafts] = useState<Record<string, HcDraft>>({})
  const [saving, setSaving] = useState(false)
  /** 保存没成：哪一项（null 是整体）、为什么 */
  const [failure, setFailure] = useState<{ key: string | null; error: ChannelErrorShape } | null>(
    null,
  )
  /** 开始改的时候这一块被别处动过几次：之后又动了，提示一句 */
  const [base, setBase] = useState(slot.revision)
  const [asking, setAsking] = useState<HcAction | null>(null)
  /** 撞上冲突时看到的版本：核心重读的结果到之前，再存还是会冲突，先不让存 */
  const [staleVersion, setStaleVersion] = useState<string | null>(null)
  /**
   * 写成了、写之前的版本：新读到的那一份（版本变了）到了再收起改动，不然控件会先闪回旧值。
   * 读不到或者迟迟不到也收起
   */
  const [landing, setLanding] = useState<string | null>(null)
  const data = slot.data
  const dirty = Object.keys(drafts)
  const landed = landing !== null && (data?.version !== landing || slot.error !== null)
  useEffect(() => {
    if (landing === null) return
    const settle = () => {
      setDrafts({})
      setLanding(null)
    }
    if (landed) {
      settle()
      return
    }
    const timer = setTimeout(settle, 5000)
    return () => clearTimeout(timer)
  }, [landing, landed])
  useEffect(() => {
    if (dirty.length === 0) setBase(slot.revision)
  }, [dirty.length, slot.revision])
  const moved = dirty.length > 0 && slot.revision > base
  // 有没保存的改动：离开前问（“保存”走下面的 save）
  const leave = useLeaveGuard(dirty.length > 0 && landing === null)

  const reload = () => {
    channel
      .command('harnessConfig.reload', { deviceId: device.id, harness: harnessId, part: 'config' })
      .catch(() => {})
  }
  if (!data) return <SlotState slot={slot} onRetry={reload} />

  const edit = (spec: HcSettingSpec, draft: HcDraft | null) => {
    setFailure(null)
    setDrafts((current) => {
      const next = { ...current }
      if (draft === null || sameAsStored(spec, draft, data.values[spec.key])) delete next[spec.key]
      else next[spec.key] = draft
      return next
    })
  }
  const parsed: Record<string, Parsed> = {}
  for (const key of dirty) {
    const spec = data.settings.find((one) => one.key === key)
    const draft = drafts[key]
    if (spec && draft) parsed[key] = parseDraft(spec, draft)
  }
  const wrong = Object.values(parsed).some((one) => !one.ok)
  const rereading = staleVersion !== null && data.version === staleVersion && !slot.error

  const busy = saving || landing !== null
  const save = async () => {
    const edits = Object.entries(parsed).flatMap(([key, one]) =>
      one.ok ? [{ key, value: one.value }] : [],
    )
    if (busy || wrong || rereading || edits.length === 0) return false
    setSaving(true)
    setFailure(null)
    setStaleVersion(null)
    try {
      const result = await channel.command('harnessConfig.write', {
        deviceId: device.id,
        harness: harnessId,
        edits,
        expectedVersion: data.version,
      })
      setLanding(data.version)
      showToast({
        id: `hc-saved:${device.id}:${harnessId}`,
        text: (say) =>
          say(result.restartRequired ? 'hc.saved.restart' : 'hc.saved', { count: edits.length }),
        lifeMs: 4000,
      })
      return true
    } catch (error) {
      const shape = error as ChannelErrorShape
      // 版本冲突：核心在重读这一块，改动留着，看着最新的再保存
      if (shape?.code === 'conflict') setStaleVersion(data.version)
      setFailure({ key: shape?.code === 'conflict' ? null : (shape?.key ?? null), error: shape })
      return false
    } finally {
      setSaving(false)
    }
  }
  leave.current = save

  const runAction = async (action: HcAction) => {
    setAsking(null)
    try {
      await channel.command('harnessConfig.action', {
        deviceId: device.id,
        harness: harnessId,
        actionId: action.id,
      })
      showToast({
        id: `hc-action:${action.id}`,
        text: (say) => say('hc.action.done', { name: say.said(action.title) }),
        lifeMs: 4000,
      })
    } catch (error) {
      showToast({
        id: `hc-action:${action.id}`,
        tone: 'err',
        text: (say) =>
          say('hc.action.failed', { name: say.said(action.title), reason: whyNot(error, say) }),
        lifeMs: 9000,
      })
    }
  }

  const known = new Set(data.groups.map((group) => group.id))
  const groups = [
    ...data.groups,
    // 没声明分组的项归在“其他”
    ...(data.settings.some((spec) => !known.has(spec.group)) ||
    data.actions.some((one) => !known.has(one.group))
      ? [
          {
            id: '',
            title: { 'zh-CN': t('manage.group.other'), en: t('manage.group.other') },
            description: null,
          },
        ]
      : []),
  ]
  const inGroup = (id: string, group: string) => (id === '' ? !known.has(group) : group === id)

  return (
    <div className="hc-tab" data-hc-tab="config" data-version={data.version}>
      {moved ? (
        <div className="mng-conflict" role="alert" data-hc-moved>
          <span>{t('hc.moved')}</span>
          <button
            type="button"
            className="mini"
            data-act="hc-keep-mine"
            onClick={() => setBase(slot.revision)}
          >
            {t('manage.conflict.keepMine')}
          </button>
          <button
            type="button"
            className="mini"
            data-act="hc-take-latest"
            onClick={() => setDrafts({})}
          >
            {t('manage.conflict.takeLatest')}
          </button>
        </div>
      ) : null}
      {groups.map((group) => {
        const specs = data.settings.filter((spec) => inGroup(group.id, spec.group))
        const actions = data.actions.filter((action) => inGroup(group.id, action.group))
        if (specs.length === 0 && actions.length === 0) return null
        return (
          <section key={group.id} className="mng-sec hc-group" data-hc-group={group.id}>
            <div className="mng-sec-head">
              <h2>{t.said(group.title)}</h2>
            </div>
            {group.description ? <p className="mng-sec-note">{t.said(group.description)}</p> : null}
            {specs.length > 0 ? (
              <div className="mng-h">
                <div className="mng-rows">
                  {specs.map((spec) => (
                    <ConfigRow
                      key={spec.key}
                      device={device}
                      spec={spec}
                      data={data}
                      draft={drafts[spec.key]}
                      parsed={parsed[spec.key]}
                      refused={failure?.key === spec.key ? failure.error : null}
                      saving={busy}
                      onDraft={(draft) => edit(spec, draft)}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            {actions.length > 0 ? (
              <div className="hc-actions">
                {actions.map((action) => (
                  <span key={action.id} className="hc-action" data-hc-action={action.id}>
                    <button
                      type="button"
                      className={action.danger ? 'btn danger' : 'btn'}
                      onClick={() => (action.confirm ? setAsking(action) : void runAction(action))}
                    >
                      {t.said(action.title)}
                    </button>
                    {action.description ? (
                      <span className="form-note">{t.said(action.description)}</span>
                    ) : null}
                  </span>
                ))}
              </div>
            ) : null}
          </section>
        )
      })}
      {data.files.length > 0 ? (
        <div className="hc-files form-note">
          {t('hc.files')}
          {data.files.map((file) => (
            <code key={file.path} className="mono">
              {file.path}
            </code>
          ))}
        </div>
      ) : null}
      {dirty.length > 0 ? (
        <footer
          className="mng-save"
          data-hc-save
          data-dirty-count={dirty.length}
          data-saving={busy}
        >
          <div className="mng-save-in">
            <div className="mng-save-text">
              <b>{t('manage.save.count', { count: dirty.length })}</b>
              {failure && failure.key === null ? (
                <span
                  className="mng-save-note err"
                  role="alert"
                  data-hc-failure={failure.error.code}
                >
                  {failure.error.code === 'conflict'
                    ? t('hc.conflict')
                    : t('manage.save.failed', { reason: whyNot(failure.error, t) })}
                </span>
              ) : wrong ? (
                <span className="mng-save-note err">{t('manage.save.fix')}</span>
              ) : null}
            </div>
            <button
              type="button"
              className="btn ghost"
              data-act="hc-discard"
              disabled={busy}
              onClick={() => setDrafts({})}
            >
              {t('manage.discard')}
            </button>
            <button
              type="button"
              className="btn primary"
              data-act="hc-save"
              disabled={busy || wrong || rereading}
              onClick={() => void save()}
            >
              {t(busy ? 'manage.saving' : 'manage.save')}
            </button>
          </div>
        </footer>
      ) : null}
      {asking ? (
        <Confirm
          title={t.said(asking.title)}
          note={asking.confirm ? t.said(asking.confirm) : ''}
          yes={t('hc.action.yes')}
          no={t('permission.confirm.no')}
          onYes={() => void runAction(asking)}
          onClose={() => setAsking(null)}
        />
      ) : null}
    </div>
  )
}

interface RowProps {
  device: DeviceView
  spec: HcSettingSpec
  data: HcConfigView
  draft: HcDraft | undefined
  parsed: Parsed | undefined
  refused: ChannelErrorShape | null
  saving: boolean
  onDraft(draft: HcDraft | null): void
}

function ConfigRow({ device, spec, data, draft, parsed, refused, saving, onDraft }: RowProps) {
  const t = useT()
  const valueText = useHcValueText()
  const stored: HcValue | undefined = data.values[spec.key]
  const written = spec.key in data.values
  const overridden = data.overridden[spec.key]
  const id = `hc-${device.id}-${spec.key}`
  const wide = isWide(spec)
  const effect = effectKey(spec.effect)
  const problem = parsed && !parsed.ok ? parsed.problem : null
  const action = draft ? (
    <button
      type="button"
      className="mini"
      data-act="hc-revert"
      disabled={saving}
      onClick={() => onDraft(null)}
    >
      {t('manage.revert')}
    </button>
  ) : written && spec.clearable && !spec.readOnly ? (
    <button
      type="button"
      className="mini"
      data-act="hc-clear"
      disabled={saving}
      title={t('manage.reset.note', { value: valueText(spec, spec.default) })}
      onClick={() => onDraft({ kind: 'clear' })}
    >
      {t(spec.type === 'secret' ? 'manage.secret.clear' : 'manage.reset')}
    </button>
  ) : null
  const range =
    (spec.type === 'integer' || spec.type === 'number') &&
    spec.minimum !== null &&
    spec.maximum !== null
      ? t('manage.range', { minimum: spec.minimum, maximum: spec.maximum })
      : null
  return (
    <div
      className={wide ? 'mng-row wide' : 'mng-row'}
      data-hc-key={spec.key}
      data-type={spec.type}
      data-dirty={draft !== undefined}
      data-written={written}
      data-readonly={spec.readOnly}
    >
      <div className="mng-row-text">
        <div className="mng-row-head">
          <label className="mng-row-title" htmlFor={id}>
            {t.said(spec.title)}
            {effect ? (
              <span className="mng-tag" data-effect={spec.effect}>
                {t(effect)}
              </span>
            ) : null}
            {spec.readOnly ? <span className="mng-tag">{t('hc.readOnly')}</span> : null}
          </label>
          {wide ? (
            <>
              <span className="grow" />
              {action}
            </>
          ) : null}
        </div>
        {spec.description || range ? (
          <span className="form-note">
            {spec.description ? t.said(spec.description) : null}
            {range ? ` ${range}` : null}
          </span>
        ) : null}
        {!written && spec.default !== null && spec.type !== 'boolean' && spec.type !== 'secret' ? (
          <span className="form-note" data-hc-default>
            {t('hc.default', { value: valueText(spec, spec.default) })}
          </span>
        ) : null}
      </div>
      <div className="mng-row-ctl">
        <HcControl
          id={id}
          spec={spec}
          stored={stored}
          draft={draft}
          disabled={saving}
          wrong={problem !== null}
          onDraft={(next) => onDraft(next)}
        />
        {wide ? null : action}
      </div>
      {draft?.kind === 'clear' ? (
        <div className="mng-row-note">
          {t('manage.reset.pending', { value: valueText(spec, spec.default) })}
        </div>
      ) : null}
      {overridden ? (
        <div className="mng-row-note hc-over" data-hc-overridden>
          {t('hc.overridden', {
            value: valueText(spec, overridden.value),
            by: t.said(overridden.by),
          })}
        </div>
      ) : null}
      {spec.readOnly && spec.readOnlyReason ? (
        <div className="mng-row-note">{t.said(spec.readOnlyReason)}</div>
      ) : null}
      {problem ? (
        <div className="mng-row-note err" role="alert">
          {t(problem)}
        </div>
      ) : null}
      {refused ? (
        <div className="mng-row-note err" role="alert" data-refused>
          {whyNot(refused, t)}
        </div>
      ) : null}
    </div>
  )
}
