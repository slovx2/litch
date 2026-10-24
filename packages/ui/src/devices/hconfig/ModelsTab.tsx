// 模型清单这一块（config 说有 modelCatalog 的 harness 才有这个标签，现在只有原生 Codex）：
// 顶上说在用自带目录还是自定义清单（清单存在哪个文件）、改了怎么生效、对面的说明和锁住的原因。
// 自定义清单整份替换自带目录，所以“开始自定义”先把自带目录整份导成原样用的项，用户再删、加、改、排。
// 一项一行：显示名、上下文、模型名、原样用还是以谁为底稿；上下移动（顺序就是模型选择里的顺序）、改、删。
// 改动攒在草稿里一起保存；版本冲突时核心已经重读，草稿留着，看着最新的再保存。恢复自带目录先在界面里确认。
import type { ChannelErrorShape, DeviceView, HcModelEntry, HcModelsView, HcSlot } from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { Confirm } from '../../app/Confirm.tsx'
import { whyNot } from '../../app/errors.ts'
import { Down, Up } from '../../app/icons.tsx'
import { useLeaveGuard } from '../../app/leave-guard.tsx'
import { useServices } from '../../app/services.tsx'
import { showToast } from '../../app/toasts.tsx'
import { effectKey } from './logic.ts'
import { ModelDialog } from './ModelDialog.tsx'
import { asIs, importAll, moved, resolved, sameEntries, shortWindow } from './models.ts'
import { SlotState } from './parts.tsx'

interface ModelsTabProps {
  device: DeviceView
  harnessId: string
  /** harness 给人看的名字（“恢复 Codex 自带目录”里用） */
  name: string
  slot: HcSlot<HcModelsView>
}

export function ModelsTab({ device, harnessId, name, slot }: ModelsTabProps) {
  const t = useT()
  const { channel } = useServices()
  /** 正在改的清单；null 是没在改，照读到的显示 */
  const [draft, setDraft] = useState<HcModelEntry[] | null>(null)
  /** 正在新增（index 为 null）或改第几项 */
  const [editing, setEditing] = useState<{ index: number | null } | null>(null)
  const [asking, setAsking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<ChannelErrorShape | null>(null)
  /** 撞上冲突时看到的版本：核心重读的结果到之前，再存还是会冲突，先不让存 */
  const [staleVersion, setStaleVersion] = useState<string | null>(null)
  /** 写成了、写之前的版本：新读到的那一份到了再收起草稿，免得先闪回旧的 */
  const [landing, setLanding] = useState<string | null>(null)
  /** 开始改的时候这一块被别处动过几次：之后又动了，提示一句 */
  const [base, setBase] = useState(slot.revision)
  const data = slot.data
  const landed = landing !== null && (data?.version !== landing || slot.error !== null)
  useEffect(() => {
    if (landing === null) return
    const settle = () => {
      setDraft(null)
      setLanding(null)
    }
    if (landed) {
      settle()
      return
    }
    const timer = setTimeout(settle, 5000)
    return () => clearTimeout(timer)
  }, [landing, landed])
  const editingNow = draft !== null
  useEffect(() => {
    if (!editingNow) setBase(slot.revision)
  }, [editingNow, slot.revision])
  // 有没保存的清单：离开前问（“保存”走下面的 write）
  const leave = useLeaveGuard(
    draft !== null &&
      !!data &&
      landing === null &&
      (!data.custom || !sameEntries(draft, data.entries)),
  )

  if (!data) {
    return (
      <SlotState
        slot={slot}
        onRetry={() =>
          void channel
            .command('harnessConfig.reload', {
              deviceId: device.id,
              harness: harnessId,
              part: 'models',
            })
            .catch(() => {})
        }
      />
    )
  }

  const locked = data.readOnlyReason !== null
  const entries = draft ?? data.entries
  const dirty = draft !== null && (!data.custom || !sameEntries(draft, data.entries))
  const movedElsewhere = draft !== null && slot.revision > base
  const rereading = staleVersion !== null && data.version === staleVersion && !slot.error
  const busy = saving || landing !== null
  const effect = effectKey(data.effect)
  const change = (next: HcModelEntry[]) => {
    setFailure(null)
    setDraft(next)
  }

  const write = async (next: HcModelEntry[] | null): Promise<boolean> => {
    setSaving(true)
    setFailure(null)
    setStaleVersion(null)
    try {
      const result = await channel.command('harnessConfig.models.write', {
        deviceId: device.id,
        harness: harnessId,
        entries: next,
        expectedVersion: data.version,
      })
      setLanding(data.version)
      showToast({
        id: `hc-models:${device.id}:${harnessId}`,
        text: (say) =>
          next === null
            ? say(result.restartRequired ? 'hc.models.restored.restart' : 'hc.models.restored', {
                name,
              })
            : say(result.restartRequired ? 'hc.models.saved.restart' : 'hc.models.saved', {
                count: next.length,
              }),
        lifeMs: 4000,
      })
      return true
    } catch (error) {
      const shape = error as ChannelErrorShape
      if (next === null) {
        // 恢复没成：没有保存条可以挂，弹一句
        showToast({
          id: `hc-models:${device.id}:${harnessId}`,
          tone: 'err',
          text: (say) =>
            shape?.code === 'conflict'
              ? say('hc.models.conflict')
              : say('hc.failed', { reason: whyNot(shape, say) }),
          lifeMs: 9000,
        })
        return false
      }
      if (shape?.code === 'conflict') setStaleVersion(data.version)
      setFailure(shape)
      return false
    } finally {
      setSaving(false)
    }
  }
  leave.current = async () =>
    !busy && !rereading && entries.length > 0 && dirty ? write(entries) : false
  const restore = () => {
    setAsking(false)
    void write(null)
  }

  const taken = (except: number | null) =>
    new Set(entries.flatMap((entry, at) => (at === except ? [] : [entry.id])))
  const showingList = data.custom || draft !== null

  return (
    <div
      className="hc-tab hc-models"
      data-hc-tab="models"
      data-version={data.version}
      data-custom={data.custom}
      data-editing={draft !== null}
    >
      <section className="mng-sec hc-models-head">
        <div className="mng-sec-head">
          <h2 className="ell" data-hc-models-state={data.custom ? 'custom' : 'builtin'}>
            {data.custom ? t('hc.models.state.custom') : t('hc.models.state.builtin', { name })}
          </h2>
          {effect ? (
            <span className="mng-tag" data-effect={data.effect}>
              {t(effect)}
            </span>
          ) : null}
        </div>
        <p className="mng-sec-note">
          {data.custom
            ? t('hc.models.custom.note', { name })
            : t('hc.models.builtin.note', { name })}
        </p>
        {data.path ? (
          <div className="hc-files form-note" data-hc-models-path>
            {data.custom ? t('hc.files') : t('hc.models.pathLater')}
            <code className="mono">{data.path}</code>
          </div>
        ) : null}
        {data.note ? (
          <p className="mng-sec-note" data-hc-models-note>
            {t.said(data.note)}
          </p>
        ) : null}
        {locked && data.readOnlyReason ? (
          <p className="mng-sec-note hc-locked" data-hc-models-locked>
            {t('hc.models.locked', { reason: t.said(data.readOnlyReason) })}
          </p>
        ) : null}
        {!showingList && !locked ? (
          <div className="hc-actions">
            <button
              type="button"
              className="btn primary"
              data-act="hc-models-start"
              disabled={busy || data.bases.length === 0}
              onClick={() => change(importAll(data.bases))}
            >
              {t('hc.models.start')}
            </button>
            <span className="form-note">{t('hc.models.start.note')}</span>
          </div>
        ) : null}
      </section>

      {movedElsewhere ? (
        <div className="mng-conflict" role="alert" data-hc-moved>
          <span>{t('hc.models.moved')}</span>
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
            onClick={() => setDraft(null)}
          >
            {t('manage.conflict.takeLatest')}
          </button>
        </div>
      ) : null}

      <section className="mng-sec">
        <div className="mng-sec-head">
          <h2>
            {showingList
              ? t('hc.models.list', { count: entries.length })
              : t('hc.models.bases', { name, count: data.bases.length })}
          </h2>
        </div>
        {showingList ? <p className="mng-sec-note">{t('hc.models.list.note')}</p> : null}
        {showingList ? (
          entries.length === 0 ? (
            <div className="mng-state" data-hc-models-empty>
              {t('hc.models.empty')}
            </div>
          ) : (
            <div className="mng-h">
              <div className="mng-rows">
                {entries.map((entry, index) => (
                  <ModelRow
                    key={entry.id}
                    entry={entry}
                    data={data}
                    index={index}
                    count={entries.length}
                    edited={
                      data.custom &&
                      draft !== null &&
                      !sameEntries([entry], data.entries.slice(index, index + 1))
                    }
                    disabled={busy}
                    locked={locked}
                    onMove={(step) => change(moved(entries, index, step))}
                    onEdit={() => setEditing({ index })}
                    onRemove={() => change(entries.filter((_, at) => at !== index))}
                  />
                ))}
              </div>
            </div>
          )
        ) : (
          <div className="mng-h">
            <div className="mng-rows">
              {data.bases.map((one) => (
                <div className="mng-row hc-model" key={one.id} data-hc-base={one.id}>
                  <div className="mng-row-text">
                    <div className="mng-row-head">
                      <span className="mng-row-title ell">{one.displayName}</span>
                      <WindowTag value={one.contextWindow} />
                    </div>
                    <code className="mono ell form-note">{one.id}</code>
                    {one.description ? <span className="form-note">{one.description}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {showingList && !locked ? (
          <div className="hc-actions">
            <button
              type="button"
              className="btn"
              data-act="hc-models-add"
              disabled={busy}
              onClick={() => setEditing({ index: null })}
            >
              {t('hc.models.add')}
            </button>
            {data.custom ? (
              <button
                type="button"
                className="btn ghost"
                data-act="hc-models-restore"
                disabled={busy}
                onClick={() => setAsking(true)}
              >
                {t('hc.models.restore', { name })}
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      {draft !== null && (dirty || failure) ? (
        <footer
          className="mng-save"
          data-hc-save
          data-dirty-count={entries.length}
          data-saving={busy}
        >
          <div className="mng-save-in">
            <div className="mng-save-text">
              <b>
                {data.custom
                  ? t('hc.models.save.changed')
                  : t('hc.models.save.start', { count: entries.length })}
              </b>
              {failure ? (
                <span className="mng-save-note err" role="alert" data-hc-failure={failure.code}>
                  {failure.code === 'conflict'
                    ? t('hc.models.conflict')
                    : t('manage.save.failed', { reason: whyNot(failure, t) })}
                </span>
              ) : entries.length === 0 ? (
                <span className="mng-save-note err">{t('hc.models.save.empty')}</span>
              ) : (
                <span className="mng-save-note">{t('hc.models.save.note')}</span>
              )}
            </div>
            <button
              type="button"
              className="btn ghost"
              data-act="hc-discard"
              disabled={busy}
              onClick={() => {
                setDraft(null)
                setFailure(null)
              }}
            >
              {t('manage.discard')}
            </button>
            <button
              type="button"
              className="btn primary"
              data-act="hc-save"
              disabled={busy || rereading || entries.length === 0 || !dirty}
              onClick={() => void write(entries)}
            >
              {t(busy ? 'manage.saving' : 'manage.save')}
            </button>
          </div>
        </footer>
      ) : null}

      {editing ? (
        <ModelDialog
          bases={data.bases}
          entry={editing.index === null ? null : (entries[editing.index] ?? null)}
          taken={taken(editing.index)}
          onDone={(entry) => {
            const index = editing.index
            change(
              index === null
                ? [...entries, entry]
                : entries.map((one, at) => (at === index ? entry : one)),
            )
            setEditing(null)
          }}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {asking ? (
        <Confirm
          title={t('hc.models.restore.title', { name })}
          note={t('hc.models.restore.note', { name })}
          yes={t('hc.models.restore.yes')}
          no={t('permission.confirm.no')}
          onYes={restore}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </div>
  )
}

/** 上下文窗口：写短，悬停看完整的数 */
function WindowTag({ value }: { value: number | null }) {
  const t = useT()
  if (value === null) return null
  return (
    <span
      className="mng-tag hc-window"
      title={t('hc.models.window.full', { count: value.toLocaleString('en-US') })}
      data-window={value}
    >
      {shortWindow(value)}
    </span>
  )
}

interface RowProps {
  entry: HcModelEntry
  data: HcModelsView
  index: number
  count: number
  /** 和读到的同一位置那一项不一样（草稿里改过、挪过、新加的） */
  edited: boolean
  disabled: boolean
  /** 被锁住：只看，不给操作 */
  locked: boolean
  onMove(step: -1 | 1): void
  onEdit(): void
  onRemove(): void
}

function ModelRow({
  entry,
  data,
  index,
  count,
  edited,
  disabled,
  locked,
  onMove,
  onEdit,
  onRemove,
}: RowProps) {
  const t = useT()
  const shown = resolved(entry, data.bases)
  const baseName = shown.base?.displayName ?? entry.base
  return (
    <div
      className="mng-row hc-model"
      data-hc-model={entry.id}
      data-base={entry.base}
      data-as-is={asIs(entry)}
      data-dirty={edited}
    >
      <div className="mng-row-text">
        <div className="mng-row-head">
          <span className="mng-row-title ell">{shown.name}</span>
          <WindowTag value={shown.window} />
        </div>
        <span className="form-note hc-model-line">
          <code className="mono ell">{entry.id}</code>
          <span className={shown.base ? 'dim' : 'err'} data-hc-model-base>
            {!shown.base
              ? t('hc.models.baseGone', { base: entry.base })
              : asIs(entry)
                ? t('hc.models.asIs', { base: baseName })
                : t('hc.models.basedOn', { base: baseName })}
          </span>
        </span>
      </div>
      {locked ? null : (
        <div className="mng-row-ctl hc-model-acts">
          <button
            type="button"
            className="ibtn"
            data-act="hc-model-up"
            title={t('hc.models.up')}
            aria-label={t('hc.models.up')}
            disabled={disabled || index === 0}
            onClick={() => onMove(-1)}
          >
            <Up />
          </button>
          <button
            type="button"
            className="ibtn"
            data-act="hc-model-down"
            title={t('hc.models.down')}
            aria-label={t('hc.models.down')}
            disabled={disabled || index === count - 1}
            onClick={() => onMove(1)}
          >
            <Down />
          </button>
          <button
            type="button"
            className="mini"
            data-act="hc-model-edit"
            disabled={disabled}
            onClick={onEdit}
          >
            {t('hc.edit')}
          </button>
          <button
            type="button"
            className="mini"
            data-act="hc-model-remove"
            disabled={disabled}
            onClick={onRemove}
          >
            {t('hc.remove')}
          </button>
        </div>
      )}
    </div>
  )
}
