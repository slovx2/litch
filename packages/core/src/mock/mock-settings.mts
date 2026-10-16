// 模拟核心里“设备服务”管设置的那一半：算出现在的值、检查写进来的改动。都是不带状态的函数。
// 规矩照真的设备服务（cmd/codex-harness-adapter 的 settings*.go）：一次写入全有或全无；
// 密钥只写不读回——这里更干脆，写进来的密钥当场丢掉，只记“设过了”。
import { ChannelError } from '../channel/protocol.mjs'
import type { HarnessView } from '../model.mjs'
import type {
  EnvEntryView,
  SettingEditView,
  SettingSpecView,
  SettingsSnapshotView,
  SettingValueView,
  SshEntryView,
} from '../model-manage.mjs'
import { looksSecret } from '../projection/manage.mjs'
import { both, type SampleSettings } from './sample-manage.mjs'

export interface MockSettings extends SampleSettings {
  version: number
  pending: Set<string>
}

const valueNow = (state: MockSettings, spec: SettingSpecView): SettingValueView =>
  state.written.get(spec.key) ?? spec.default

/** 一项设置现在的值。没有这一项就是 undefined */
export function currentValue(state: MockSettings, key: string): SettingValueView | undefined {
  const spec = state.settings.find((entry) => entry.key === key)
  return spec ? valueNow(state, spec) : undefined
}

/** 各个 SSH 入口现在的状况：看开没开、它的 harness 在不在跑、端口是不是被占着 */
function sshEntries(state: MockSettings, harnesses: HarnessView[]): SshEntryView[] {
  return harnesses.flatMap((harness): SshEntryView[] => {
    const enabled = currentValue(state, `ssh.${harness.id}.enabled`)
    const port = currentValue(state, `ssh.${harness.id}.port`)
    if (typeof enabled !== 'boolean' || typeof port !== 'number') return []
    const taken = enabled && harness.state === 'ready' && port === state.takenPort
    return [
      {
        harness: harness.id,
        enabled,
        port,
        state: !enabled
          ? 'off'
          : harness.state !== 'ready'
            ? 'idle'
            : taken
              ? 'failed'
              : 'listening',
        reason: taken
          ? {
              kind: 'portUnavailable',
              text: both(
                `端口 ${port} 被别的程序占着。它空出来之后入口会自己接上；也可以换一个端口。`,
                `Port ${port} is in use by another program. The entry comes up by itself once the port is free, or you can pick another port.`,
              ),
              detail: `listen tcp 127.0.0.1:${port}: bind: address already in use`,
            }
          : null,
      },
    ]
  })
}

export function snapshotOf(state: MockSettings, harnesses: HarnessView[]): SettingsSnapshotView {
  const values: Record<string, SettingValueView> = {}
  for (const spec of state.settings) values[spec.key] = valueNow(state, spec)
  return {
    version: state.version,
    values,
    explicit: [...state.written.keys()],
    pendingRestart: [...state.pending],
    sshEntries: sshEntries(state, harnesses),
  }
}

/** 这一项的值不合规矩：整个写入作废 */
const invalid = (key: string, zh: string, en: string): ChannelError =>
  new ChannelError('invalid', zh, undefined, { said: both(zh, en), key })

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 环境变量表存下来的样子。密钥的值不留：不带值的密钥得是原来就有的 */
function envOf(key: string, value: unknown, before: SettingValueView | undefined) {
  if (!Array.isArray(value))
    throw invalid(key, '这一项要填环境变量表', 'This takes a list of variables')
  const kept = new Set(
    (Array.isArray(before) ? before : [])
      .filter((entry) => entry.secret)
      .map((entry) => entry.name),
  )
  const seen = new Set<string>()
  return value.map((entry: EnvEntryView): EnvEntryView => {
    const name = typeof entry?.name === 'string' ? entry.name : ''
    if (!NAME.test(name)) {
      throw invalid(
        key,
        `变量名“${name}”不合规矩：只能用字母、数字和下划线，不能以数字开头`,
        `“${name}” is not a valid variable name: letters, digits and underscores only, not starting with a digit`,
      )
    }
    if (seen.has(name)) {
      throw invalid(key, `变量 ${name} 出现了两次`, `The variable ${name} appears twice`)
    }
    seen.add(name)
    const secret = entry.secret === true || looksSecret(name)
    if (typeof entry.value !== 'string' && !(secret && kept.has(name))) {
      throw invalid(key, `变量 ${name} 没有给值`, `The variable ${name} has no value`)
    }
    return secret ? { name, secret: true } : { name, value: entry.value ?? '' }
  })
}

/** 一项改动存下来是什么。undefined 表示清掉，回到默认值 */
function stored(
  spec: SettingSpecView,
  value: SettingEditView['value'],
  before: SettingValueView | undefined,
): SettingValueView | undefined {
  const { key } = spec
  if (value === null) return undefined
  switch (spec.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw invalid(key, '这一项要填开或关', 'This is on or off')
      return value
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw invalid(key, '这一项要填整数', 'This takes a whole number')
      }
      if (spec.minimum !== null && value < spec.minimum) {
        throw invalid(key, `不能小于 ${spec.minimum}`, `Must be at least ${spec.minimum}`)
      }
      if (spec.maximum !== null && value > spec.maximum) {
        throw invalid(key, `不能大于 ${spec.maximum}`, `Must be at most ${spec.maximum}`)
      }
      return value
    }
    case 'env': {
      const entries = envOf(key, value, before)
      return entries.length > 0 ? entries : undefined
    }
    case 'string':
    case 'path':
    case 'enum':
    case 'secret':
      break
    default:
      throw invalid(key, '这一项不能在这里改', 'This setting cannot be changed here')
  }
  if (typeof value !== 'string') throw invalid(key, '这一项要填文字', 'This takes text')
  // 空着就是没填，和清掉是一回事
  if (value === '') return undefined
  if (spec.type === 'secret') return { set: true }
  if (/[\r\n]/.test(value)) throw invalid(key, '里面不能有换行', 'It cannot contain a line break')
  if (spec.type === 'path' && !value.startsWith('/')) {
    throw invalid(key, '要写绝对路径', 'Must be an absolute path')
  }
  if (spec.type === 'enum' && !spec.options.some((option) => option.value === value)) {
    throw invalid(key, '不在可选的值里', 'Not one of the available choices')
  }
  return value
}

/**
 * 把一批改动落到设置上：全部合规矩才落，有一项不行就一项都不落（抛 invalid）。
 * 返回真的变了的键。新填的密钥算变了：值看不出来，但它确实换过了。
 */
export function commit(state: MockSettings, edits: readonly SettingEditView[]): string[] {
  const next = new Map(state.written)
  const touched = new Set<string>()
  for (const edit of edits) {
    const spec = state.settings.find((entry) => entry.key === edit.key)
    if (!spec) throw invalid(edit.key, '没有这一项设置', 'There is no such setting')
    const before = next.get(spec.key)
    const value = stored(spec, edit.value, before)
    const fresh =
      (spec.type === 'secret' && typeof edit.value === 'string' && edit.value !== '') ||
      (Array.isArray(edit.value) &&
        edit.value.some((entry) => typeof entry.value === 'string' && looksLikeSecret(entry)))
    if (value === undefined) next.delete(spec.key)
    else next.set(spec.key, value)
    const was = JSON.stringify(before ?? spec.default)
    if (fresh || was !== JSON.stringify(value ?? spec.default)) touched.add(spec.key)
  }
  // 各入口的端口不能相同
  const ports = new Map<number, string>()
  for (const spec of state.settings) {
    if (!/^ssh\..+\.port$/.test(spec.key)) continue
    const port = next.get(spec.key) ?? spec.default
    if (typeof port !== 'number') continue
    const other = ports.get(port)
    if (other !== undefined) {
      const key = touched.has(spec.key) ? spec.key : other
      throw invalid(
        key,
        '这个端口已经给了另一个入口，各入口的端口不能相同',
        'Another entry already uses this port; each entry needs its own',
      )
    }
    ports.set(port, spec.key)
  }
  if (touched.size > 0) {
    state.written = next
    state.version++
  }
  return [...touched]
}

const looksLikeSecret = (entry: EnvEntryView): boolean =>
  entry.secret === true || looksSecret(entry.name)

/**
 * 别的客户端改了两项设置：这个 harness 的入口端口，和终端保留多久。
 * 两项都是立刻生效的那种，不牵扯重启。返回改了的键
 */
export function editElsewhere(state: MockSettings, harness: string): string[] {
  const edits: SettingEditView[] = []
  const port = currentValue(state, `ssh.${harness}.port`)
  if (typeof port === 'number') edits.push({ key: `ssh.${harness}.port`, value: port + 100 })
  const keep = state.settings.find((spec) => spec.key === 'terminal.keepAlive')
  if (keep) {
    const at = keep.options.findIndex((option) => option.value === valueNow(state, keep))
    const next = keep.options[(at + 1) % keep.options.length]
    if (next) edits.push({ key: keep.key, value: next.value })
  }
  return commit(state, edits)
}

/** 设备服务多了一项设置（相当于它升级了）：加在这个 harness 那一组里。已经有了就不再加 */
export function addSetting(state: MockSettings, harness: string): boolean {
  const key = `harness.${harness}.startupNote`
  if (state.settings.some((spec) => spec.key === key)) return false
  const group = `harness.${harness}`
  const at = state.settings.findLastIndex((spec) => spec.group === group)
  if (at < 0) return false
  state.settings = state.settings.toSpliced(at + 1, 0, {
    key,
    group,
    type: 'string',
    scope: { kind: 'harness', harness },
    default: '',
    restart: 'none',
    role: null,
    minimum: null,
    maximum: null,
    options: [],
    title: both('启动时的备注', 'Startup note'),
    description: both(
      '设备服务新加的一项：每次启动这个 harness 时写进它的日志开头。',
      'Newly added by the device service: written at the top of this harness’s log on every start.',
    ),
  })
  return true
}
