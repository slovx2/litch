// 一项设置占一行：标题和说明在左，按类型画的控件在右（环境变量表这种宽的在下面）。
// 这一行改过没保存、被别处动过、填得不对、设备服务不认，都在这一行上说。
import type { SettingSpecView, SettingsSnapshotView } from '@litch/core'
import { useEffect } from 'react'
import { useT } from '../../app/appearance.ts'
import { whyNot } from '../../app/errors.ts'
import { Control, KNOWN_TYPES, useValueText } from './controls.tsx'
import {
  type Draft,
  type DraftEdit,
  dropDrafts,
  editDraft,
  problemOf,
  rebaseDraft,
  type SaveFailure,
  sameAsStored,
  setDraft,
} from './drafts.ts'
import { EnvEditor } from './EnvEditor.tsx'

interface SettingRowProps {
  deviceId: string
  spec: SettingSpecView
  snapshot: SettingsSnapshotView
  /** 这一项的值从打开到现在被动过几次 */
  revision: number
  draft: Draft | undefined
  saving: boolean
  failure: SaveFailure | null
  /** 改了这一项要重启哪个 harness 才生效：它的名字。立刻生效的是 null */
  restarts: string | null
}

/**
 * 一个 harness 的设置里，设备服务标了“启用开关”角色的那一项：标题行上也放一个，不用点开就能拨。
 * 它和点开之后的那一行是同一项、同一份草稿：在这里拨了，那一行跟着变，没保存、被别处动过照旧在那一行上说
 */
export function LeadSwitch(props: Omit<SettingRowProps, 'failure' | 'restarts'>) {
  const { deviceId, spec, snapshot, revision, draft, saving } = props
  const t = useT()
  const stored = snapshot.values[spec.key]
  const origin = { revision, stored }
  return (
    <span className="mng-lead" data-lead={spec.key}>
      <Control
        id={`lead-${deviceId}-${spec.key}`}
        spec={spec}
        stored={stored}
        edit={draft?.edit ?? null}
        disabled={saving}
        wrong={false}
        label={t.said(spec.title)}
        onEdit={(next) => editDraft(deviceId, spec, next, origin)}
      />
    </span>
  )
}

export function SettingRow(props: SettingRowProps) {
  const { deviceId, spec, snapshot, revision, draft, saving, failure, restarts } = props
  const t = useT()
  const valueText = useValueText()
  const { key } = spec
  const stored = snapshot.values[key]
  const known = KNOWN_TYPES.includes(spec.type)
  const explicit = snapshot.explicit.includes(key)
  const edit = draft?.edit ?? null
  // 开始改之后这一项又被动过：别处改的。自己正在保存的那一下不算
  const conflict = draft !== undefined && draft.base !== revision && !saving
  const problem = edit ? problemOf(spec, edit) : null
  const refused = failure?.key === key ? failure.error : null

  // 别处改成的值正好和这边想改成的一样：这一栏就不用再留着了
  const same = edit !== null && sameAsStored(spec, edit, stored)
  useEffect(() => {
    if (same) dropDrafts(deviceId, [key])
  }, [same, deviceId, key])

  const origin = { revision, stored }
  const onEdit = (next: DraftEdit) => editDraft(deviceId, spec, next, origin)
  const id = `set-${deviceId}-${key}`
  const control = { id, spec, stored, edit, disabled: saving, wrong: problem !== null, onEdit }
  const wide = spec.type === 'env' || !known
  const range =
    spec.type === 'integer' && spec.minimum !== null && spec.maximum !== null
      ? t('manage.range', { minimum: spec.minimum, maximum: spec.maximum })
      : null

  // 改过的可以撤销；没改过、设置里写过的可以回到默认值（密钥是清除）
  const action = draft ? (
    <button
      type="button"
      className="mini"
      data-act="revert"
      disabled={saving}
      onClick={() => dropDrafts(deviceId, [key])}
    >
      {t('manage.revert')}
    </button>
  ) : explicit && known ? (
    <button
      type="button"
      className="mini"
      data-act="reset"
      disabled={saving}
      title={t('manage.reset.note', { value: valueText(spec, spec.default) })}
      onClick={() => setDraft(deviceId, key, { kind: 'reset' }, origin)}
    >
      {t(spec.type === 'secret' ? 'manage.secret.clear' : 'manage.reset')}
    </button>
  ) : null

  return (
    <div
      className={wide ? 'mng-row wide' : 'mng-row'}
      data-setting={key}
      data-type={spec.type}
      data-dirty={draft !== undefined}
      data-conflict={conflict}
      data-explicit={explicit}
    >
      <div className="mng-row-text">
        <div className="mng-row-head">
          <label className="mng-row-title" htmlFor={id}>
            {t.said(spec.title)}
            {restarts ? (
              <span className="mng-tag" title={t('manage.restartNeeded', { name: restarts })}>
                {t('manage.restartTag')}
              </span>
            ) : null}
          </label>
          {wide ? (
            <>
              <span className="grow" />
              {action}
            </>
          ) : null}
        </div>
        <span className="form-note">
          {t.said(spec.description)}
          {range ? ` ${range}` : null}
        </span>
      </div>
      <div className="mng-row-ctl">
        {spec.type === 'env' ? <EnvEditor {...control} /> : <Control {...control} />}
        {wide ? null : action}
      </div>
      {edit?.kind === 'reset' && spec.type !== 'secret' ? (
        <div className="mng-row-note">
          {t('manage.reset.pending', { value: valueText(spec, spec.default) })}
        </div>
      ) : null}
      {problem ? (
        <div className="mng-row-note err" role="alert">
          {t(problem.key, problem.args)}
        </div>
      ) : null}
      {refused ? (
        <div className="mng-row-note err" role="alert" data-refused>
          {whyNot(refused, t)}
        </div>
      ) : null}
      {conflict ? (
        <div className="mng-conflict" role="alert">
          <span>{t('manage.conflict.field', { value: valueText(spec, stored) })}</span>
          <button
            type="button"
            className="mini"
            data-act="take-latest"
            onClick={() => dropDrafts(deviceId, [key])}
          >
            {t('manage.conflict.takeLatest')}
          </button>
          <button
            type="button"
            className="mini"
            data-act="keep-mine"
            onClick={() => rebaseDraft(deviceId, key, origin)}
          >
            {t('manage.conflict.keepMine')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
