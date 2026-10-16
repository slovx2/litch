// 环境变量表：一行一个变量，可以加、删、改。
// 密钥的值界面上没有：原来就存着的只显示“已设置”，要换就重新填一个；新填的用遮住的输入框。
// 环境文件里的那些变量（对每个 harness 都生效）只读，另外列一处（InheritedEnv）。
import { type InheritedEnvView, looksSecret } from '@litch/core'
import { useId, useMemo } from 'react'
import { useT } from '../../app/appearance.ts'
import { Fold, useFold } from '../../app/Fold.tsx'
import { Close, Plus } from '../../app/icons.tsx'
import type { ControlProps } from './controls.tsx'
import { type EnvRow, newRow, rowIsSecret, rowsOf } from './drafts.ts'

export function EnvEditor({ id, spec, stored, edit, disabled, onEdit }: ControlProps) {
  const t = useT()
  const source = edit?.kind === 'reset' ? spec.default : stored
  // 没改过的时候，行是从存着的值来的；值不换，行的标识就不换
  const pristine = useMemo(() => rowsOf(source), [source])
  const rows = edit?.kind === 'env' ? edit.rows : pristine
  const change = (next: EnvRow[]) => onEdit({ kind: 'env', rows: next })
  const patch = (row: EnvRow, fields: Partial<EnvRow>) =>
    change(rows.map((entry) => (entry === row ? { ...row, ...fields } : entry)))

  return (
    <div className="env" id={id}>
      {rows.length === 0 ? <div className="form-note">{t('manage.env.none')}</div> : null}
      {rows.map((row) => {
        const secret = rowIsSecret(row)
        const byName = looksSecret(row.name)
        return (
          <div key={row.id} className="env-row" data-env={row.name} data-secret={secret}>
            <input
              className="req-input mono env-name"
              value={row.name}
              placeholder={t('manage.env.name')}
              aria-label={t('manage.env.name')}
              // 原来就存着的密钥改不了名字：换了名字对面就对不上原来的值了
              disabled={disabled || row.kept}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(event) => patch(row, { name: event.target.value })}
            />
            {row.kept ? (
              <span className="env-kept">
                <span className="pill ok">{t('manage.secret.set')}</span>
                <button
                  type="button"
                  className="mini"
                  data-act="env-replace"
                  disabled={disabled}
                  onClick={() => patch(row, { kept: false, value: '' })}
                >
                  {t('manage.env.replace')}
                </button>
              </span>
            ) : (
              <input
                className="req-input mono env-value"
                type={secret ? 'password' : 'text'}
                value={row.value}
                placeholder={t(secret ? 'manage.secret.enter' : 'manage.env.value')}
                aria-label={t('manage.env.value')}
                disabled={disabled}
                autoComplete={secret ? 'new-password' : 'off'}
                autoCapitalize="off"
                spellCheck={false}
                onChange={(event) => patch(row, { value: event.target.value })}
              />
            )}
            <label
              className="form-check env-secret"
              title={byName ? t('manage.env.secretByName') : undefined}
            >
              <input
                type="checkbox"
                checked={secret}
                // 名字看着像密钥的，设备服务不问就按密钥存，这里不让取消
                disabled={disabled || row.kept || byName}
                onChange={(event) => patch(row, { secret: event.target.checked })}
              />
              {t('manage.env.secret')}
            </label>
            <button
              type="button"
              className="ibtn"
              data-act="env-remove"
              title={t('manage.env.remove')}
              aria-label={t('manage.env.remove')}
              disabled={disabled}
              onClick={() => change(rows.filter((entry) => entry !== row))}
            >
              <Close />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        className="mini env-add"
        data-act="env-add"
        disabled={disabled}
        onClick={() => change([...rows, newRow()])}
      >
        <Plus />
        {t('manage.env.add')}
      </button>
    </div>
  )
}

/**
 * 环境文件里的变量：对每个 harness 都生效，只读。密钥只说“已设置”。
 * 平时收成一行（有几个），点开才是说明和清单：它们改不了，不值得一直占着页面上方
 */
export function InheritedEnv({ entries }: { entries: readonly InheritedEnvView[] }) {
  const t = useT()
  const fold = useFold(false)
  const id = useId()
  if (entries.length === 0) return null
  return (
    <div className="env-inherited" data-open={fold.open}>
      <Fold open={fold.open} onToggle={fold.toggle} controls={id}>
        {t('manage.env.inherited.title')}
        <span className="dim">{t('manage.value.env', { count: entries.length })}</span>
      </Fold>
      {fold.open ? (
        <div id={id} className="env-inherited-body">
          <span className="form-note">{t('manage.env.inherited')}</span>
          <ul>
            {entries.map((entry) => (
              <li key={entry.name} data-inherited={entry.name}>
                <code className="mono">{entry.name}</code>
                {entry.secret || entry.value === undefined ? (
                  <span className="pill mute">{t('manage.secret.set')}</span>
                ) : (
                  <code className="mono dim">{entry.value}</code>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
