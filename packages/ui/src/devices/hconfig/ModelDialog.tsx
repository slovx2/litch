// 模型清单里新增、改一项的对话框：先挑底稿（自带目录里的模型，可以按名字筛），再选原样用它、
// 还是以它为底稿换模型名、显示名、上下文窗口（留空照底稿）。只改草稿，保存在外面的保存条上。
import type { HcModelBase, HcModelEntry } from '@litch/core'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { entryOfForm, filterBases, formOfEntry, type ModelForm, shortWindow } from './models.ts'
import { HcDialog } from './parts.tsx'

interface DialogProps {
  bases: readonly HcModelBase[]
  /** 改的那一项；新增是 null */
  entry: HcModelEntry | null
  /** 清单里别的项已经用了的模型名 */
  taken: ReadonlySet<string>
  onDone(entry: HcModelEntry): void
  onClose(): void
}

export function ModelDialog({ bases, entry, taken, onDone, onClose }: DialogProps) {
  const t = useT()
  const [form, setForm] = useState<ModelForm>(() => formOfEntry(entry, bases, taken))
  const [query, setQuery] = useState('')
  const list = useRef<HTMLDivElement>(null)
  // 一打开就让选中的底稿露在单子里（改靠后的那几项时它不在头几行）
  useEffect(() => {
    const picked = list.current?.querySelector<HTMLElement>('[data-picked="true"]')
    const box = list.current
    if (!picked || !box) return
    box.scrollTop += picked.getBoundingClientRect().top - box.getBoundingClientRect().top - 4
  }, [])
  const set = (patch: Partial<ModelForm>) => setForm((current) => ({ ...current, ...patch }))
  const base = bases.find((one) => one.id === form.base) ?? null
  const result = entryOfForm(form, bases, taken)
  const shown = filterBases(bases, query)
  // 底稿不在筛出来的里面也留着它，免得选中的那一项看不见
  const options = base && !shown.includes(base) ? [base, ...shown] : shown
  // 模型名还空着时不急着说“要填”
  const problem =
    !result.ok && !(result.problem === 'hc.models.bad.id' && form.id.trim() === '') ? result : null

  const pick = (next: HcModelBase) => {
    // 自定义时模型名还是原底稿的名字（没改过）：跟着换
    const followId = form.mode === 'custom' && (form.id === '' || form.id === form.base)
    set({ base: next.id, ...(followId ? { id: next.id } : {}) })
  }
  const mode = (next: ModelForm['mode']) =>
    set({ mode: next, ...(next === 'custom' && form.id === '' ? { id: form.base } : {}) })

  const field = (key: string, label: string, control: ReactNode, note?: string) => (
    <div className="form-field" data-hc-field={key}>
      <label className="form-label" htmlFor={`hc-model-${key}`}>
        {label}
      </label>
      {control}
      {note ? <span className="form-note">{note}</span> : null}
      {problem && !problem.ok && problem.field === key ? (
        <span className="form-note err" role="alert">
          {t(problem.problem, { id: form.mode === 'same' ? form.base : form.id.trim() })}
        </span>
      ) : null}
    </div>
  )

  return (
    <HcDialog
      title={entry ? t('hc.models.edit', { id: entry.id }) : t('hc.models.add')}
      kind="model"
      wide
      busy={false}
      failure={null}
      yes={entry ? t('hc.models.dialog.apply') : t('hc.models.dialog.add')}
      ready={result.ok}
      onSubmit={() => {
        if (result.ok) onDone(result.entry)
      }}
      onClose={onClose}
    >
      {field(
        'base',
        t('hc.models.base'),
        <div className="hc-bases">
          {bases.length > 6 ? (
            <input
              id="hc-model-base"
              className="req-input"
              type="search"
              value={query}
              placeholder={t('hc.models.base.filter')}
              aria-label={t('hc.models.base.filter')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
          <div
            ref={list}
            className="hc-base-list"
            role="radiogroup"
            aria-label={t('hc.models.base')}
          >
            {options.length === 0 ? (
              <span className="form-note">{t('hc.models.base.none')}</span>
            ) : (
              options.map((one) => (
                <label
                  key={one.id}
                  className="hc-base-opt"
                  data-hc-base-option={one.id}
                  data-picked={one.id === form.base}
                >
                  <input
                    type="radio"
                    name="hc-model-base"
                    checked={one.id === form.base}
                    onChange={() => pick(one)}
                  />
                  <span className="hc-base-text">
                    <span className="hc-base-name">
                      <b className="ell">{one.displayName}</b>
                      {one.contextWindow !== null ? (
                        <span className="mng-tag">{shortWindow(one.contextWindow)}</span>
                      ) : null}
                      {taken.has(one.id) ? (
                        <span className="mng-tag" data-hc-base-taken>
                          {t('hc.models.base.taken')}
                        </span>
                      ) : null}
                    </span>
                    <code className="mono ell">{one.id}</code>
                    {one.description ? <span className="dim ell">{one.description}</span> : null}
                  </span>
                </label>
              ))
            )}
          </div>
        </div>,
      )}
      <div className="form-field" data-hc-field="mode">
        <span className="form-label">{t('hc.models.mode')}</span>
        {/* biome-ignore lint/a11y/useSemanticElements: 分段按钮，不用 fieldset */}
        <div className="seg" role="group" aria-label={t('hc.models.mode')}>
          {(['same', 'custom'] as const).map((one) => (
            <button
              key={one}
              type="button"
              data-mode={one}
              aria-pressed={form.mode === one}
              onClick={() => mode(one)}
            >
              {t(one === 'same' ? 'hc.models.mode.same' : 'hc.models.mode.custom')}
            </button>
          ))}
        </div>
        <span className="form-note">
          {form.mode === 'same'
            ? t('hc.models.mode.same.note', { base: base?.displayName ?? form.base })
            : t('hc.models.mode.custom.note', { base: base?.displayName ?? form.base })}
        </span>
      </div>
      {form.mode === 'custom' ? (
        <>
          {field(
            'id',
            t('hc.models.id'),
            <input
              id="hc-model-id"
              className="req-input mono"
              value={form.id}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set({ id: event.target.value })}
            />,
            t('hc.models.id.note'),
          )}
          {field(
            'displayName',
            t('hc.models.displayName'),
            <input
              id="hc-model-displayName"
              className="req-input"
              value={form.displayName}
              placeholder={base?.displayName ?? ''}
              autoComplete="off"
              onChange={(event) => set({ displayName: event.target.value })}
            />,
            t('hc.models.displayName.note'),
          )}
          {field(
            'contextWindow',
            t('hc.models.window'),
            <input
              id="hc-model-contextWindow"
              className="req-input mono hc-window-input"
              inputMode="numeric"
              value={form.contextWindow}
              placeholder={base?.contextWindow != null ? String(base.contextWindow) : ''}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set({ contextWindow: event.target.value })}
            />,
            base?.contextWindow != null
              ? t('hc.models.window.note', { value: shortWindow(base.contextWindow) })
              : t('hc.models.window.noteNone'),
          )}
        </>
      ) : null}
    </HcDialog>
  )
}
