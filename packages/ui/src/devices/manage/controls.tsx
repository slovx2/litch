// 按类型画的控件。界面不认识哪一项设置是干什么的，只看设备服务声明的类型：
// 开关、一行字、路径、整数、单选、密钥各一种画法（环境变量表在 EnvEditor.tsx）；
// 这一版不认识的类型只读地摆出来并说明，不出错。
import type { SettingSpecView, SettingValueView } from '@litch/core'
import { useT } from '../../app/appearance.ts'
import type { DraftEdit } from './drafts.ts'

export interface ControlProps {
  /** 控件的 id，行里的标题用它指过来 */
  id: string
  spec: SettingSpecView
  /** 现在存着的值 */
  stored: SettingValueView | undefined
  /** 这一栏的草稿。没改过是 null */
  edit: DraftEdit | null
  disabled: boolean
  /** 填得不对：控件画成出错的样子 */
  wrong: boolean
  /** 旁边没有写着标题的地方用（harness 标题行上的开关）：读屏的时候、鼠标停上去的时候说这是什么 */
  label?: string
  onEdit(edit: DraftEdit): void
}

/** 这一版界面会画的类型 */
export const KNOWN_TYPES = ['boolean', 'string', 'path', 'integer', 'enum', 'secret', 'env']

/** 控件里该显示的值：有草稿显示草稿；草稿是“回到默认值”就显示默认值；否则是存着的 */
const shown = ({ spec, stored, edit }: ControlProps): SettingValueView | undefined =>
  edit?.kind === 'reset' ? spec.default : stored

function Switch(props: ControlProps) {
  const { id, edit, disabled, label, onEdit } = props
  const on = edit?.kind === 'boolean' ? edit.value : shown(props) === true
  return (
    <button
      id={id}
      type="button"
      role="switch"
      className="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onEdit({ kind: 'boolean', value: !on })}
    >
      <i />
    </button>
  )
}

function TextField(props: ControlProps) {
  const { id, spec, edit, disabled, wrong, onEdit } = props
  const t = useT()
  const value = shown(props)
  const text = edit?.kind === 'text' ? edit.value : value == null ? '' : String(value)
  const numeric = spec.type === 'integer'
  const classes = ['req-input', numeric ? 'mng-num mono' : '', spec.type === 'path' ? 'mono' : '']
  if (wrong) classes.push('wrong')
  // 默认值是空的那种（比如“留空就到 PATH 里找”），空着的时候提示一句
  const placeholder = !numeric && spec.default === '' ? t('manage.text.empty') : undefined
  return (
    <input
      id={id}
      className={classes.filter(Boolean).join(' ')}
      value={text}
      placeholder={placeholder}
      inputMode={numeric ? 'numeric' : undefined}
      disabled={disabled}
      autoComplete="off"
      autoCapitalize="off"
      spellCheck={false}
      aria-invalid={wrong}
      onChange={(event) => onEdit({ kind: 'text', value: event.target.value })}
    />
  )
}

function Choice(props: ControlProps) {
  const { id, spec, edit, disabled, onEdit } = props
  const t = useT()
  const value = shown(props)
  const current = edit?.kind === 'text' ? edit.value : typeof value === 'string' ? value : ''
  // 存着的值不在可选的里面（设备服务换过选项）：照样列出来，不让它凭空变成第一项
  const listed = spec.options.some((option) => option.value === current)
  return (
    <select
      id={id}
      className="req-input mng-select"
      value={current}
      disabled={disabled}
      onChange={(event) => onEdit({ kind: 'text', value: event.target.value })}
    >
      {listed ? null : <option value={current}>{current}</option>}
      {spec.options.map((option) => (
        <option key={option.value} value={option.value}>
          {t.said(option.title)}
        </option>
      ))}
    </select>
  )
}

/** 密钥：存着的值界面上没有，只知道设没设过；只能填一个新的 */
function Secret(props: ControlProps) {
  const { id, stored, edit, disabled, onEdit } = props
  const t = useT()
  const set = typeof stored === 'object' && stored !== null && 'set' in stored && stored.set
  const clearing = edit?.kind === 'reset'
  return (
    <span className="mng-secret">
      <span className={set && !clearing ? 'pill ok' : 'pill mute'} data-secret-state>
        {t(clearing ? 'manage.secret.clearing' : set ? 'manage.secret.set' : 'manage.secret.unset')}
      </span>
      <input
        id={id}
        type="password"
        className="req-input mono"
        value={edit?.kind === 'text' ? edit.value : ''}
        placeholder={t(set ? 'manage.secret.replace' : 'manage.secret.enter')}
        disabled={disabled}
        autoComplete="new-password"
        spellCheck={false}
        onChange={(event) => onEdit({ kind: 'text', value: event.target.value })}
      />
    </span>
  )
}

/** 不认识的类型：把值摆出来（简单的值才有），说明这一版改不了 */
function Unknown({ id, spec, stored }: ControlProps) {
  const t = useT()
  const text = stored == null || typeof stored === 'object' ? null : String(stored)
  return (
    <span className="mng-unknown" id={id}>
      <code className="mono">{text ?? t('manage.unknown.noValue')}</code>
      <span className="form-note">{t('manage.unknown.note', { type: spec.type })}</span>
    </span>
  )
}

/** 一项设置的控件（环境变量表除外） */
export function Control(props: ControlProps) {
  switch (props.spec.type) {
    case 'boolean':
      return <Switch {...props} />
    case 'string':
    case 'path':
    case 'integer':
      return <TextField {...props} />
    case 'enum':
      return <Choice {...props} />
    case 'secret':
      return <Secret {...props} />
    default:
      return <Unknown {...props} />
  }
}

/** 一个值写成一小段字：用在“别处已改成……”“默认是……”这类说明里。密钥和表不写出内容 */
export function useValueText(): (
  spec: SettingSpecView,
  value: SettingValueView | undefined,
) => string {
  const t = useT()
  return (spec, value) => {
    if (typeof value === 'boolean') return t(value ? 'manage.value.on' : 'manage.value.off')
    if (typeof value === 'number') return String(value)
    if (typeof value === 'string') {
      const option = spec.options.find((entry) => entry.value === value)
      if (option) return t.said(option.title)
      return value === '' ? t('manage.value.empty') : value
    }
    if (Array.isArray(value)) return t('manage.value.env', { count: value.length })
    if (value && typeof value === 'object') {
      return t(value.set ? 'manage.secret.set' : 'manage.secret.unset')
    }
    return t('manage.unknown.noValue')
  }
}
