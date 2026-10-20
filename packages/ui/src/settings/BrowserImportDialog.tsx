// “从别的浏览器导入”的对话框：选来源和资料 → 勾类别（可选只导哪些网站的 Cookie）→ 关浏览器、系统授权、
// 管理员同意的提示 → 逐类进度 → 逐类结果（导入、已存在、无效、失败；没成的说为什么、能重试的给“重试”）。
// 设置页、浏览器面板的菜单和横幅三处打开的都是它（BrowserImportEntry.tsx）。
// 只经外壳的 window.litchBrowser.import 说话，拿到的只有来源、资料名、条数和状态；阶段怎么换、结果怎么说
// 都在 browser-import-logic.ts。
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { currentPlatform } from '../app/platform.ts'
import type { MessageKey } from '../i18n/index.ts'
import type {
  BrowserImportBridge,
  ImportKind,
  ImportRequest,
  ImportSource,
} from '../side/browser/bridge.ts'
import {
  ElevateCheck,
  ImportProgressView,
  ImportResultView,
  KIND_TEXT,
} from './BrowserImportResult.tsx'
import {
  BLOCK_TEXT,
  canClose,
  chosenOf,
  type DraftProblem,
  draftFor,
  type ImportDraft,
  type ImportStep,
  importStep,
  initialDraft,
  KINDS,
  kindLook,
  LOOK_TEXT,
  PROBLEM_TEXT,
  pickedKinds,
  profileBlock,
  profileLabel,
  reportOf,
  requestOf,
  retryRequest,
  sourceBlock,
  wantsElevation,
  wantsSystemAuth,
} from './browser-import-logic.ts'
import '../styles/browser-import.css'

const KIND_NOTE: Record<ImportKind, MessageKey> = {
  cookies: 'bimport.kind.cookies.note',
  passwords: 'bimport.kind.passwords.note',
}

interface DialogProps {
  bridge: BrowserImportBridge
  /** 关掉（导没导都叫）：打开它的那一处再取一次“导过没有” */
  onClose(): void
}

export function BrowserImportDialog({ bridge, onClose }: DialogProps) {
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  const [step, send] = useReducer(importStep, { name: 'loading' } satisfies ImportStep)
  const [draft, setDraft] = useState<ImportDraft | null>(null)
  const [problem, setProblem] = useState<{ key: DraftProblem; bad?: string[] } | null>(null)
  /** 结果页上勾的“允许用管理员权限读取” */
  const [consent, setConsent] = useState(false)
  const running = useRef(false)
  running.current = step.name === 'running'

  // 用模态方式打开：焦点留在里面，Esc 由浏览器处理
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])

  const load = useCallback(() => {
    let live = true
    send({ type: 'load' })
    bridge.sources().then(
      (sources) => {
        if (!live) return
        send({ type: 'loaded', sources })
        // 还在的话留着上次选的，不然回到默认
        setDraft((previous) => {
          const source = previous && sources.find((one) => one.browser === previous.browser)
          return source && sourceBlock(source) === null
            ? draftFor(source, previous.profileId, previous)
            : initialDraft(sources)
        })
      },
      (error: unknown) => {
        if (live) send({ type: 'loadFailed', reason: reasonOf(error, t) })
      },
    )
    return () => {
      live = false
    }
  }, [bridge, t])
  useEffect(() => load(), [load])

  useEffect(() => bridge.onProgress((progress) => send({ type: 'progress', progress })), [bridge])

  // 对话框没了（比如切走了页面）还在导：停下来，不留一个看不见的导入
  useEffect(
    () => () => {
      if (running.current) void bridge.cancel().catch(() => {})
    },
    [bridge],
  )

  const run = (request: ImportRequest, retry: boolean) => {
    send(retry ? { type: 'retry', request } : { type: 'start', request })
    setConsent(false)
    bridge.start(request).then(
      (outcome) => send({ type: 'finished', outcome }),
      (error: unknown) => send({ type: 'startFailed', reason: reasonOf(error, t) }),
    )
  }

  const stop = () => {
    send({ type: 'stop' })
    void bridge.cancel().catch(() => {})
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (step.name !== 'pick' || !draft) return
    const built = requestOf(step.sources, draft)
    if ('problem' in built) {
      setProblem({ key: built.problem, ...(built.bad ? { bad: built.bad } : {}) })
      return
    }
    setProblem(null)
    run(built.request, false)
  }

  const nameOf = (browser: string) =>
    ('sources' in step ? step.sources : []).find((one) => one.browser === browser)?.name ?? browser

  const title = t('bimport.title')
  return (
    <dialog
      ref={dialog}
      className="modal bimp-dialog"
      aria-label={title}
      data-step={step.name}
      onCancel={(event) => {
        // 正在导的时候 Esc 不关：要先停
        if (!canClose(step)) event.preventDefault()
      }}
      onClose={onClose}
      onKeyDown={(event) => {
        // Esc 只关这个对话框，别让外面的 Esc 处理也跟着动
        if (event.key === 'Escape') event.stopPropagation()
      }}
    >
      <form onSubmit={submit}>
        <div className="modal-head">
          <span className="grow">{title}</span>
        </div>
        {step.name === 'loading' ? (
          <div className="modal-body">
            <p className="modal-note">{t('bimport.loading')}</p>
          </div>
        ) : step.name === 'loadFailed' ? (
          <div className="modal-body">
            <p className="modal-note err" role="alert">
              {t('bimport.loadFailed', { reason: step.reason })}
            </p>
          </div>
        ) : step.name === 'pick' ? (
          draft ? (
            <PickForm
              sources={step.sources}
              draft={draft}
              problem={problem}
              onChange={(next) => {
                setDraft(next)
                setProblem(null)
              }}
            />
          ) : (
            <div className="modal-body">
              <p className="modal-note" data-bimp="none">
                {t('bimport.none')}
              </p>
            </div>
          )
        ) : step.name === 'running' ? (
          <ImportProgressView
            name={nameOf(step.request.browser)}
            stages={step.stages}
            stopping={step.stopping}
          />
        ) : step.name === 'done' ? (
          <ImportResultView
            name={nameOf(step.origin.browser)}
            origin={step.origin}
            outcome={step.outcome}
            consent={consent}
            onConsent={setConsent}
          />
        ) : (
          <div className="modal-body">
            <p className="modal-note err" role="alert">
              {t('bimport.startFailed', { reason: step.reason })}
            </p>
          </div>
        )}
        <DialogFoot
          note={
            step.name === 'pick' && problem ? (
              <span className="grow modal-note err" role="alert" data-problem={problem.key}>
                {t(PROBLEM_TEXT[problem.key], { list: (problem.bad ?? []).join(', ') })}
              </span>
            ) : null
          }
          step={step}
          ready={step.name === 'pick' && draft !== null}
          consent={consent}
          onClose={onClose}
          onReload={load}
          onStop={stop}
          onRetry={(request) => run(request, true)}
          onBack={() => send({ type: 'back' })}
        />
      </form>
    </dialog>
  )
}

/** 选来源、资料、类别，以及动手前的提示 */
function PickForm({
  sources,
  draft,
  problem,
  onChange,
}: {
  sources: ImportSource[]
  draft: ImportDraft
  problem: { key: DraftProblem; bad?: string[] } | null
  onChange(next: ImportDraft): void
}) {
  const t = useT()
  const chosen = chosenOf(sources, draft)
  const source = chosen?.source
  const picked = pickedKinds(sources, draft)
  const set = (patch: Partial<ImportDraft>) => onChange({ ...draft, ...patch })
  const cookies = picked.includes('cookies')
  return (
    <div className="modal-body bimp-pick">
      <fieldset className="form-field bimp-sources">
        <legend className="form-label">{t('bimport.source')}</legend>
        {sources.map((one) => {
          const block = sourceBlock(one)
          return (
            <label
              key={one.browser}
              className={block ? 'bimp-source off' : 'bimp-source'}
              data-browser={one.browser}
            >
              <input
                type="radio"
                name="bimp-source"
                value={one.browser}
                checked={one.browser === draft.browser}
                disabled={block !== null}
                onChange={() => onChange(draftFor(one, undefined, draft))}
              />
              <span className="bimp-source-name">{one.name}</span>
              {block ? <span className="form-note">{t(BLOCK_TEXT[block])}</span> : null}
            </label>
          )
        })}
      </fieldset>
      {source && source.profiles.length > 1 ? (
        <div className="form-field">
          <label className="form-label" htmlFor="bimp-profile">
            {t('bimport.profile')}
          </label>
          <select
            id="bimp-profile"
            className="req-input"
            value={draft.profileId}
            onChange={(event) => onChange(draftFor(source, event.target.value, draft))}
          >
            {source.profiles.map((profile) => {
              const label = profileLabel(profile)
              const blocked = profileBlock(source, profile)
              return (
                <option key={profile.id} value={profile.id} disabled={blocked !== null}>
                  {profile.isDefault ? t('bimport.profile.default', { name: label }) : label}
                  {blocked ? ` · ${t(BLOCK_TEXT[blocked])}` : ''}
                </option>
              )
            })}
          </select>
        </div>
      ) : chosen ? (
        <div className="form-field">
          <span className="form-label">{t('bimport.profile')}</span>
          <span className="ell">{profileLabel(chosen.profile)}</span>
        </div>
      ) : null}
      {source ? (
        <fieldset className="form-field bimp-kinds">
          <legend className="form-label">{t('bimport.kinds')}</legend>
          {KINDS.map((kind) => {
            const look = kindLook(source, chosen?.profile, kind)
            return (
              <label key={kind} className={look === 'ok' ? 'bimp-kind' : 'bimp-kind off'}>
                <input
                  type="checkbox"
                  data-kind={kind}
                  checked={look === 'ok' && draft.kinds[kind]}
                  disabled={look !== 'ok'}
                  onChange={(event) =>
                    set({ kinds: { ...draft.kinds, [kind]: event.target.checked } })
                  }
                />
                <span className="bimp-kind-text">
                  <span>{t(KIND_TEXT[kind])}</span>
                  <span className="form-note">
                    {look === 'ok' ? t(KIND_NOTE[kind]) : t(LOOK_TEXT[look])}
                  </span>
                </span>
              </label>
            )
          })}
        </fieldset>
      ) : null}
      {source ? (
        <div className="form-field bimp-domains">
          <label className={cookies ? 'bimp-kind' : 'bimp-kind off'}>
            <input
              type="checkbox"
              data-field="only-domains"
              checked={cookies && draft.onlyDomains}
              disabled={!cookies}
              onChange={(event) => set({ onlyDomains: event.target.checked })}
            />
            <span>{t('bimport.domains')}</span>
          </label>
          {cookies && draft.onlyDomains ? (
            <>
              <textarea
                className="req-input mono bimp-domain-list"
                data-field="cookie-domains"
                rows={2}
                value={draft.domainsText}
                placeholder={t('bimport.domains.placeholder')}
                aria-label={t('bimport.domains')}
                aria-invalid={problem?.key === 'badDomains' || problem?.key === 'noDomains'}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => set({ domainsText: event.target.value })}
              />
              <span className="form-note">{t('bimport.domains.note')}</span>
            </>
          ) : null}
        </div>
      ) : null}
      {source ? <PickHints source={source} kinds={picked} draft={draft} onChange={set} /> : null}
    </div>
  )
}

/** 动手前的提示：先退出来源浏览器；会弹系统授权；Windows 上要不要管理员同意 */
function PickHints({
  source,
  kinds,
  draft,
  onChange,
}: {
  source: ImportSource
  kinds: ImportKind[]
  draft: ImportDraft
  onChange(patch: Partial<ImportDraft>): void
}) {
  const t = useT()
  const name = source.name
  return (
    <div className="callout bimp-hints">
      <p>{t('bimport.hint.close', { name })}</p>
      {wantsSystemAuth(source, kinds) ? (
        <p data-hint="system-auth">
          {currentPlatform() === 'mac'
            ? t('bimport.hint.keychain', { name })
            : t('bimport.hint.systemAuth')}
        </p>
      ) : null}
      {wantsElevation(source, kinds) ? (
        <ElevateCheck
          name={name}
          checked={draft.allowElevated}
          onChange={(on) => onChange({ allowElevated: on })}
        />
      ) : null}
    </div>
  )
}

/** 对话框底下的按钮，看阶段给 */
function DialogFoot({
  note,
  step,
  ready,
  consent,
  onClose,
  onReload,
  onStop,
  onRetry,
  onBack,
}: {
  /** 底栏左边的一句（表单哪里不对），没有就空着 */
  note: ReactNode
  step: ImportStep
  /** 表单能交 */
  ready: boolean
  consent: boolean
  onClose(): void
  onReload(): void
  onStop(): void
  onRetry(request: ImportRequest): void
  onBack(): void
}) {
  const t = useT()
  const close = (key: MessageKey = 'bimport.close', primary = false) => (
    <button
      type="button"
      className={primary ? 'btn primary' : 'btn'}
      data-act="bimp-close"
      onClick={onClose}
    >
      {t(key)}
    </button>
  )
  const reload = (
    <button type="button" className="btn primary" data-act="bimp-rescan" onClick={onReload}>
      {t('bimport.rescan')}
    </button>
  )
  let buttons: ReactNode
  switch (step.name) {
    case 'loading':
      buttons = close('bimport.cancel')
      break
    case 'loadFailed':
      buttons = (
        <>
          {close()}
          {reload}
        </>
      )
      break
    case 'pick':
      buttons = ready ? (
        <>
          {close('bimport.cancel')}
          <button type="submit" className="btn primary" data-act="bimp-start">
            {t('bimport.start')}
          </button>
        </>
      ) : (
        <>
          {close()}
          {reload}
        </>
      )
      break
    case 'running':
      buttons = (
        <button
          type="button"
          className="btn"
          data-act="bimp-stop"
          disabled={step.stopping}
          onClick={onStop}
        >
          {t(step.stopping ? 'bimport.stopping' : 'bimport.stop')}
        </button>
      )
      break
    case 'done': {
      const report = reportOf(step.origin.kinds, step.outcome)
      if (report.overall === 'profile-gone') {
        buttons = (
          <>
            {close()}
            {reload}
          </>
        )
      } else if (report.overall === 'busy') {
        buttons = (
          <>
            {close()}
            <button
              type="button"
              className="btn primary"
              data-act="bimp-retry"
              onClick={() => onRetry(step.origin)}
            >
              {t('bimport.retry')}
            </button>
          </>
        )
      } else {
        const again = retryRequest(step.origin, report, consent)
        const offers = report.again.length > 0 || report.elevate.length > 0
        buttons = (
          <>
            <button type="button" className="btn ghost" data-act="bimp-back" onClick={onBack}>
              {t('bimport.again')}
            </button>
            {offers ? (
              <button
                type="button"
                className="btn"
                data-act="bimp-retry"
                disabled={again === null}
                onClick={() => again && onRetry(again)}
              >
                {t('bimport.retry')}
              </button>
            ) : null}
            {close('bimport.done', true)}
          </>
        )
      }
      break
    }
    case 'startFailed':
      buttons = (
        <>
          <button type="button" className="btn" data-act="bimp-back" onClick={onBack}>
            {t('bimport.again')}
          </button>
          {close('bimport.close', true)}
        </>
      )
      break
  }
  return (
    <div className="modal-foot">
      {note ?? <span className="grow" />}
      {buttons}
    </div>
  )
}
