// 设备详情里的“模型等级排序”：派子会话时父会话只能派同级或更低的模型，这里排哪个模型在哪一级。
// 收着时标题后面一句摘要；打开才向设备读模型清单。改动先进草稿，点“保存”才成为设备的规则。
// “跨 harness 比较等级”关着时按 harness 分组，每组一条自己的阶梯；开着时只有一条共用的阶梯。
import { type DeviceView, keys, type ModelRankingSnapshot } from '@litch/core'
import { useEffect, useId, useRef, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { whyNot } from '../../app/errors.ts'
import { Fold } from '../../app/Fold.tsx'
import { Icon } from '../../app/icons.tsx'
import { useLeaveGuard } from '../../app/leave-guard.tsx'
import { useKey, useServices } from '../../app/services.tsx'
import { RankingPartial } from './RankingPartial.tsx'
import { type RankEditor, RankLadder, UnrankedZone } from './RankLadder.tsx'
import {
  applyDrop,
  applyRank,
  crossHarnessOf,
  laddersOf,
  unrankedOf,
  writeOf,
} from './ranking-view.ts'

interface ModelRankingProps {
  device: DeviceView
  /** 别处要求直接看这一节（越级提示里的“调整模型等级”）：打开并滚到这里 */
  reveal?: boolean
  /** 打开某个 harness 的详情设置（读取失败那一条的“设置”） */
  onSettings?: ((harnessId: string) => void) | null
}

export function ModelRanking({ device, reveal = false, onSettings = null }: ModelRankingProps) {
  const deviceId = device.id
  const { channel } = useServices()
  const t = useT()
  const id = useId()
  const section = useRef<HTMLElement>(null)
  const latest = useKey<ModelRankingSnapshot>(keys.modelRanking(deviceId))
  const [open, setOpen] = useState(reveal)
  const [draft, setDraft] = useState<ModelRankingSnapshot | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  /** 键盘调级之后焦点留在被移动的那一行的手柄上 */
  const [focusKey, setFocusKey] = useState<string | null>(null)
  useEffect(() => {
    if (latest && !dirty) setDraft(latest)
  }, [latest, dirty])
  const leave = useLeaveGuard(dirty)
  const request = async (action: 'read' | 'write' | 'reset') => {
    setBusy(true)
    setError(null)
    try {
      const result =
        action === 'read'
          ? await channel.command('device.modelRanking.read', { deviceId })
          : action === 'reset'
            ? await channel.command('device.modelRanking.reset', {
                deviceId,
                expectedRevision: draft?.revision ?? 0,
              })
            : draft &&
              (await channel.command('device.modelRanking.write', { deviceId, ...writeOf(draft) }))
      if (result) {
        setDraft(result)
        setDirty(false)
        setConfirmReset(false)
      }
      return Boolean(result)
    } catch (failure) {
      setError(failure)
      return false
    } finally {
      setBusy(false)
    }
  }
  leave.current = () => request('write')
  // 打开时读一次；外面要求直接看这一节时（越级提示的跳转）也读，并滚过来
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在打开的那一下读
  useEffect(() => {
    if (open && !dirty) void request('read')
  }, [open])
  useEffect(() => {
    if (!reveal) return
    setOpen(true)
    section.current?.scrollIntoView({ block: 'start' })
  }, [reveal])
  useEffect(() => {
    if (!focusKey) return
    section.current
      ?.querySelector<HTMLElement>(`[data-rank-handle="${CSS.escape(focusKey)}"]`)
      ?.focus()
    setFocusKey(null)
  }, [focusKey])

  const edit = (next: ModelRankingSnapshot | null) => {
    if (!next || next === draft) return
    setDraft(next)
    setDirty(true)
  }
  const order = device.harnesses.map((entry) => entry.id)
  const editor: RankEditor | null = draft
    ? {
        device,
        draft,
        busy,
        dragging,
        setDragging,
        rank: (key, action) => {
          edit({ ...draft, ...applyRank(draft, key, action) })
          setFocusKey(key)
        },
        drop: (key, target) => edit({ ...draft, ...applyDrop(draft, key, target) }),
      }
    : null
  const cross = draft ? crossHarnessOf(draft) : false
  const summary = draft ? (
    <span className="mng-sum" data-mode={draft.mode} data-cross={cross}>
      {t(draft.mode === 'custom' ? 'ranking.custom' : 'ranking.builtin')} ·{' '}
      {t(cross ? 'ranking.across' : 'ranking.within')}
      {dirty ? ` · ${t('ranking.unsaved')}` : ''}
    </span>
  ) : null

  return (
    <section
      ref={section}
      className="mng-sec rk"
      data-model-ranking
      data-open={open}
      data-dragging={dragging !== null}
    >
      <div className="mng-sec-head">
        <h2>
          <Fold open={open} onToggle={() => setOpen(!open)} controls={id}>
            {t('ranking.title')}
          </Fold>
        </h2>
        {summary}
        <span className="grow" />
        {open ? (
          <button
            type="button"
            className="ibtn"
            data-act="ranking-reload"
            title={t('ranking.refresh')}
            aria-label={t('ranking.refresh')}
            disabled={busy}
            onClick={() => void request('read')}
          >
            <Icon name="reload" small />
          </button>
        ) : null}
      </div>
      {open ? (
        <div id={id} className="mng-sec-body">
          <p className="mng-sec-note">{t('ranking.intro')}</p>
          {error != null ? (
            <p className="mng-note err" role="alert">
              {whyNot(error, t)}
            </p>
          ) : null}
          {!draft ? (
            <p className="mng-note" role="status">
              {t('ranking.loading')}
            </p>
          ) : null}
          {draft && editor ? (
            <>
              <div className="rk-switch">
                <div className="rk-switch-text">
                  <label htmlFor={`${id}-cross`}>{t('ranking.cross')}</label>
                  <span className="mng-sec-note">
                    {t(cross ? 'ranking.cross.on' : 'ranking.cross.off')}
                  </span>
                </div>
                <button
                  id={`${id}-cross`}
                  type="button"
                  role="switch"
                  className="switch"
                  data-act="ranking-cross"
                  aria-checked={cross}
                  disabled={busy}
                  onClick={() => edit({ ...draft, crossHarness: !cross })}
                >
                  <i />
                </button>
              </div>
              <RankingPartial
                device={device}
                errors={draft.errors}
                busy={busy}
                onReload={() => void request('read')}
                onSettings={onSettings}
              />
              {laddersOf(draft, order).map((ladder) => (
                <RankLadder key={ladder.harness ?? 'all'} editor={editor} ladder={ladder} />
              ))}
              <UnrankedZone editor={editor} models={unrankedOf(draft, order)} />
              {draft.models.length === 0 ? <p className="mng-note">{t('ranking.empty')}</p> : null}
              <div className="rk-foot">
                {confirmReset ? (
                  <span className="rk-confirm" role="alert">
                    <span>{t('ranking.resetNote')}</span>
                    <button
                      type="button"
                      className="btn"
                      data-act="ranking-reset-confirm"
                      disabled={busy}
                      onClick={() => void request('reset')}
                    >
                      {t('ranking.resetConfirm')}
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => setConfirmReset(false)}
                    >
                      {t('ranking.cancel')}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn ghost"
                    data-act="ranking-reset"
                    disabled={busy || (draft.mode === 'builtin' && !cross)}
                    onClick={() => setConfirmReset(true)}
                  >
                    {t('ranking.reset')}
                  </button>
                )}
                <span className="grow" />
                {dirty ? (
                  <>
                    <span className="mng-sum">{t('ranking.unsaved')}</span>
                    <button
                      type="button"
                      className="btn ghost"
                      data-act="ranking-discard"
                      disabled={busy}
                      onClick={() => {
                        setDirty(false)
                        setDraft(latest ?? null)
                        if (!latest) void request('read')
                      }}
                    >
                      {t('ranking.discard')}
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  className="btn primary"
                  data-act="ranking-save"
                  disabled={busy || !dirty}
                  onClick={() => void request('write')}
                >
                  {t('ranking.save')}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
