// 指令文件这一块：上面是这个 harness 的用户级指令文件（CLAUDE.md、AGENTS.md 之类），就地编辑、保存；
// 保存时带着开始改时的那份的哈希，别处先改了就提示，可以看着最新的再存或者照样覆盖。
// 下面是设备级的“统一模式”：选一个 harness 的那份作底稿，其余各家的改成指向它的软链（原来的先备份），
// 保存前把会被换掉的文件列出来让人确认；统一了可以退出，换回各自的副本。
import type {
  ChannelErrorShape,
  DeviceView,
  HcInstructionsView,
  HcSlot,
  InstructionsOverview,
} from '@litch/core'
import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { Confirm } from '../../app/Confirm.tsx'
import { whyNot } from '../../app/errors.ts'
import { useLeaveGuard } from '../../app/leave-guard.tsx'
import { useServices } from '../../app/services.tsx'
import { showToast } from '../../app/toasts.tsx'
import { overwrittenBy } from './logic.ts'
import { HcDialog, SlotState, useRun } from './parts.tsx'

interface InstructionsTabProps {
  device: DeviceView
  harnessId: string
  slot: HcSlot<HcInstructionsView>
}

export function InstructionsTab({ device, harnessId, slot }: InstructionsTabProps) {
  const t = useT()
  const { channel } = useServices()
  const data = slot.data
  /** 编辑中的内容；null 是没动过 */
  const [draft, setDraft] = useState<string | null>(null)
  /** 开始改时那份的哈希和被别处改过几次 */
  const [base, setBase] = useState<{ hash: string; revision: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<ChannelErrorShape | null>(null)
  const [overviewKey, setOverviewKey] = useState(0)
  // 有没保存的改动：离开前问（“保存”走下面的 save）
  const leave = useLeaveGuard(draft !== null && !!data && draft !== data.content)

  if (!data) {
    return (
      <SlotState
        slot={slot}
        onRetry={() =>
          void channel
            .command('harnessConfig.reload', {
              deviceId: device.id,
              harness: harnessId,
              part: 'instructions',
            })
            .catch(() => {})
        }
      />
    )
  }
  const dirty = draft !== null && draft !== data.content
  const moved = dirty && base !== null && (slot.revision > base.revision || base.hash !== data.hash)
  const edit = (next: string) => {
    setFailure(null)
    if (base === null || draft === null) setBase({ hash: data.hash, revision: slot.revision })
    setDraft(next)
  }
  const reset = () => {
    setDraft(null)
    setBase(null)
    setFailure(null)
  }
  const save = async (): Promise<boolean> => {
    if (draft === null) return false
    setSaving(true)
    setFailure(null)
    try {
      await channel.command('harnessConfig.instructions.write', {
        deviceId: device.id,
        harness: harnessId,
        content: draft,
        expectedHash: base?.hash ?? data.hash,
      })
      reset()
      setOverviewKey((key) => key + 1)
      showToast({
        id: `hc-instr:${device.id}:${harnessId}`,
        text: (say) => say('manage.saved'),
        lifeMs: 3000,
      })
      return true
    } catch (error) {
      setFailure(error as ChannelErrorShape)
      return false
    } finally {
      setSaving(false)
    }
  }
  leave.current = async () => (dirty && !saving && !moved ? save() : false)

  return (
    <div className="hc-tab" data-hc-tab="instructions" data-hash={data.hash}>
      <section className="mng-sec">
        <div className="mng-sec-head">
          <h2>{data.fileName}</h2>
          <span className="grow" />
          <code className="mono dim ell" data-hc-path>
            {data.path}
          </code>
        </div>
        {data.exists ? null : <p className="mng-sec-note">{t('hc.instr.missing')}</p>}
        {data.linkTarget ? (
          <p className="mng-sec-note" data-hc-link>
            {t('hc.instr.link', { target: data.linkTarget })}
          </p>
        ) : null}
        {data.overriddenBy ? (
          <p className="mng-sec-note hc-over" data-hc-overridden>
            {t('hc.instr.overridden', { path: data.overriddenBy })}
          </p>
        ) : null}
        {moved ? (
          <div className="mng-conflict" role="alert" data-hc-moved>
            <span>{t('hc.instr.moved')}</span>
            <button
              type="button"
              className="mini"
              data-act="hc-keep-mine"
              onClick={() => {
                setBase({ hash: data.hash, revision: slot.revision })
                setFailure(null)
              }}
            >
              {t('manage.conflict.keepMine')}
            </button>
            <button type="button" className="mini" data-act="hc-take-latest" onClick={reset}>
              {t('manage.conflict.takeLatest')}
            </button>
          </div>
        ) : null}
        <textarea
          className="req-input hc-editor mono"
          data-hc-editor
          aria-label={data.fileName}
          value={draft ?? data.content}
          placeholder={t('hc.instr.placeholder')}
          disabled={saving}
          spellCheck={false}
          onChange={(event) => edit(event.target.value)}
        />
        {failure && failure.code !== 'conflict' ? (
          <div className="mng-row-note err" role="alert">
            {t('manage.save.failed', { reason: whyNot(failure, t) })}
          </div>
        ) : null}
        <div className="hc-actions">
          <span className="grow" />
          <button
            type="button"
            className="btn ghost"
            data-act="hc-instr-discard"
            disabled={!dirty || saving}
            onClick={reset}
          >
            {t('manage.discard')}
          </button>
          <button
            type="button"
            className="btn primary"
            data-act="hc-instr-save"
            disabled={!dirty || saving || moved}
            onClick={() => void save()}
          >
            {t(saving ? 'manage.saving' : 'manage.save')}
          </button>
        </div>
      </section>
      <UnifySection device={device} harnessId={harnessId} refresh={overviewKey} />
    </div>
  )
}

/** 设备级的统一模式 */
function UnifySection({
  device,
  harnessId,
  refresh,
}: {
  device: DeviceView
  harnessId: string
  refresh: number
}) {
  const t = useT()
  const { channel } = useServices()
  const run = useRun()
  const [overview, setOverview] = useState<InstructionsOverview | null>(null)
  const [error, setError] = useState<ChannelErrorShape | null>(null)
  const [unifying, setUnifying] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const load = useCallback(() => {
    channel.command('instructions.overview', { deviceId: device.id }).then(
      (result) => {
        setOverview(result)
        setError(null)
      },
      (failure: unknown) => setError(failure as ChannelErrorShape),
    )
  }, [channel, device.id])
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh 只是“自己存过了，重读一遍”的信号
  useEffect(() => load(), [load, refresh])

  const separate = async () => {
    setLeaving(false)
    const result = await run(`hc-separate:${device.id}`, () =>
      channel.command('instructions.separate', { deviceId: device.id }),
    )
    if (result) {
      showToast({
        id: `hc-separate:${device.id}`,
        text: (say) => say('hc.unify.separated', { count: result.separated.length }),
        lifeMs: 4000,
      })
    }
    load()
  }
  const unified = overview?.unified ?? null
  const sourceName = unified?.harness
    ? (overview?.entries.find((entry) => entry.harness === unified.harness)?.name ??
      unified.harness)
    : null

  return (
    <section className="mng-sec hc-unify" data-hc-unify={unified ? 'on' : 'off'}>
      <div className="mng-sec-head">
        <h2>{t('hc.unify.title')}</h2>
      </div>
      <p className="mng-sec-note">{t('hc.unify.note')}</p>
      {error && !overview ? (
        <div className="mng-state err" role="alert">
          <span className="grow">{t('hc.unreadable', { reason: whyNot(error, t) })}</span>
          <button type="button" className="btn" onClick={load}>
            {t('sidebar.retry')}
          </button>
        </div>
      ) : overview === null ? (
        <div className="mng-state">{t('manage.loading')}</div>
      ) : (
        <>
          {unified ? (
            <p className="hc-unify-state" data-hc-unified>
              {t('hc.unify.on', { source: unified.sourcePath, name: sourceName ?? '—' })}
            </p>
          ) : null}
          <ul className="hc-files-list">
            {overview.entries.map((entry) => (
              <li key={entry.harness} data-hc-entry={entry.harness}>
                <b>{entry.name}</b>
                {entry.info ? (
                  <>
                    <code className="mono ell">{entry.info.path}</code>
                    <span className="dim">
                      {entry.info.linkTarget
                        ? t('hc.unify.linked', { target: entry.info.linkTarget })
                        : entry.info.exists
                          ? t('hc.unify.file')
                          : t('hc.unify.missing')}
                    </span>
                  </>
                ) : (
                  <span className="dim">
                    {entry.error ? whyNot(entry.error, t) : t('hc.unify.unreadable')}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className="hc-actions">
            {unified ? (
              <button
                type="button"
                className="btn"
                data-act="hc-separate"
                onClick={() => setLeaving(true)}
              >
                {t('hc.unify.leave')}
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              data-act="hc-unify"
              onClick={() => setUnifying(true)}
            >
              {t(unified ? 'hc.unify.again' : 'hc.unify.start')}
            </button>
          </div>
        </>
      )}
      {unifying && overview ? (
        <UnifyDialog
          device={device}
          overview={overview}
          initial={unified?.harness ?? harnessId}
          onDone={load}
          onClose={() => setUnifying(false)}
        />
      ) : null}
      {leaving ? (
        <Confirm
          title={t('hc.unify.leave')}
          note={t('hc.unify.leave.note')}
          yes={t('hc.unify.leave')}
          no={t('permission.confirm.no')}
          onYes={() => void separate()}
          onClose={() => setLeaving(false)}
        />
      ) : null}
    </section>
  )
}

/** 选底稿、看一眼（可以就地改）、列出会被换掉的文件，确认后统一 */
function UnifyDialog({
  device,
  overview,
  initial,
  onDone,
  onClose,
}: {
  device: DeviceView
  overview: InstructionsOverview
  initial: string
  onDone(): void
  onClose(): void
}) {
  const t = useT()
  const { channel } = useServices()
  const readable = overview.entries.filter((entry) => entry.info !== null)
  const [source, setSource] = useState(
    readable.some((entry) => entry.harness === initial) ? initial : (readable[0]?.harness ?? ''),
  )
  const [content, setContent] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const base = readable.find((entry) => entry.harness === source)?.info ?? null
  const text = content ?? base?.content ?? ''
  const replaced = overwrittenBy(overview, source)

  const unify = async () => {
    setConfirming(false)
    setBusy(true)
    setFailure(null)
    try {
      const result = await channel.command('instructions.unify', {
        deviceId: device.id,
        harness: source,
        content: text,
      })
      const linked = result.results.filter((one) => one.outcome !== 'skipped').length
      showToast({
        id: `hc-unify:${device.id}`,
        text: (say) => say('hc.unify.done', { count: linked }),
        lifeMs: 5000,
      })
      onDone()
      onClose()
    } catch (error) {
      setBusy(false)
      setFailure(whyNot(error, t))
    }
  }
  return (
    <HcDialog
      title={t('hc.unify.title')}
      kind="unify"
      wide
      busy={busy}
      failure={failure}
      yes={t('hc.unify.start')}
      ready={base !== null}
      onSubmit={() => (replaced.length > 0 ? setConfirming(true) : void unify())}
      onClose={onClose}
    >
      <div className="form-field">
        <label className="form-label" htmlFor="hc-unify-source">
          {t('hc.unify.source')}
        </label>
        <select
          id="hc-unify-source"
          className="req-input mng-select"
          value={source}
          disabled={busy}
          onChange={(event) => {
            setSource(event.target.value)
            setContent(null)
          }}
        >
          {readable.map((entry) => (
            <option key={entry.harness} value={entry.harness}>
              {entry.name} · {entry.info?.fileName}
            </option>
          ))}
        </select>
        {base ? <code className="mono form-note">{base.path}</code> : null}
      </div>
      <textarea
        className="req-input hc-editor mono"
        data-hc-unify-editor
        aria-label={t('hc.unify.content')}
        value={text}
        disabled={busy}
        spellCheck={false}
        onChange={(event) => setContent(event.target.value)}
      />
      {replaced.length > 0 ? (
        <div className="form-note" data-hc-replaced={replaced.length}>
          {t('hc.unify.replaced')}
          <ul className="hc-files-list">
            {replaced.map((one) => (
              <li key={one.path}>
                <code className="mono">{one.path}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {confirming ? (
        <Confirm
          title={t('hc.unify.confirm.title', { count: replaced.length })}
          note={t('hc.unify.confirm.note', { files: replaced.map((one) => one.path).join(', ') })}
          yes={t('hc.unify.start')}
          no={t('permission.confirm.no')}
          onYes={() => void unify()}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </HcDialog>
  )
}
