// 测试用的假设备配置接口（协议扩展 deviceSettings）：照设备服务的应答形状和错误形状应答。
// 方法表并进假聚合面的那一份里用。它手上的值是“对面存着的原样”，测试可以故意往里放密钥，
// 看核心是不是把它们挡在了界面之外。
import type {
  DeviceSettingsSchema,
  DeviceSettingsSnapshot,
  InheritedEnvEntry,
  SettingEdit,
  SettingSpec,
} from '../../protocol/src/index.mjs'
import { type Handler, RpcFailure } from './fake-server.mjs'

const both = (zh: string, en: string) => ({ 'zh-CN': zh, en })

export function spec(
  key: string,
  type: string,
  fields: Partial<Omit<SettingSpec, 'key' | 'type'>> = {},
): SettingSpec {
  return {
    key,
    group: key.split('.').slice(0, 2).join('.'),
    type: type as SettingSpec['type'],
    title: both(`${key} 的标题`, `Title of ${key}`),
    description: both(`${key} 的说明`, `About ${key}`),
    scope: { kind: 'device' },
    default: type === 'boolean' ? false : type === 'integer' ? 0 : type === 'env' ? [] : '',
    restart: 'none',
    ...fields,
  }
}

export interface FakeSettings {
  schema: DeviceSettingsSchema
  snapshot: DeviceSettingsSnapshot
  inheritedEnv: InheritedEnvEntry[]
  /** 收到过的写入，按到达顺序 */
  writes: { expectedVersion: number; edits: SettingEdit[] }[]
  /** 之后的写入回这个错。平时是 null */
  writeFailure: RpcFailure | null
  /** 写入成功时报“已经重新启动了”的 harness */
  restartOnWrite: string[]
  /** 写入已经落下、还没应答的时候叫一下：设备服务是先广播、后应答的，测试在这里发通知 */
  beforeWriteReply: (() => void) | null
  /** 有回合在跑的 harness */
  busy: Set<string>
  restarts: { harness: string; force: boolean }[]
  /** 读设置被调用了几次 */
  reads: number
}

/** 两个 harness（pi、cc）的一份设置：每个 harness 有启用和环境变量，设备级有一个入口的开关和端口 */
export function fakeSettings(): { settings: FakeSettings; handlers: Record<string, Handler> } {
  const harnessScope = (harness: string) => ({ kind: 'harness', harness }) as const
  const settings: FakeSettings = {
    schema: {
      groups: [
        {
          id: 'harness.pi',
          title: both('Pi', 'Pi'),
          description: null,
          scope: harnessScope('pi'),
        },
        {
          id: 'ssh',
          title: both('入口', 'Entries'),
          description: both('说明', 'About'),
          scope: { kind: 'device' },
        },
      ],
      settings: [
        spec('harness.pi.enabled', 'boolean', {
          scope: harnessScope('pi'),
          default: true,
          restart: 'harness',
          role: 'enable',
        }),
        spec('harness.pi.env', 'env', { scope: harnessScope('pi'), restart: 'harness' }),
        spec('harness.pi.apiKey', 'secret', { scope: harnessScope('pi'), restart: 'harness' }),
        spec('ssh.pi.enabled', 'boolean'),
        spec('ssh.pi.port', 'integer', { default: 2200, minimum: 1, maximum: 65535 }),
      ],
    },
    snapshot: {
      version: 3,
      values: {
        'harness.pi.enabled': true,
        'harness.pi.env': [
          { name: 'HTTPS_PROXY', value: 'http://127.0.0.1:7890' },
          { name: 'PI_API_KEY', secret: true },
        ],
        'harness.pi.apiKey': { set: true },
        'ssh.pi.enabled': false,
        'ssh.pi.port': 2200,
      },
      explicit: ['harness.pi.env', 'harness.pi.apiKey'],
      pendingRestart: [],
      sshEntries: [{ harness: 'pi', enabled: false, port: 2200, state: 'off', reason: null }],
    },
    inheritedEnv: [
      { name: 'NO_PROXY', value: 'localhost', secret: false },
      { name: 'OPENAI_API_KEY', secret: true },
    ],
    writes: [],
    writeFailure: null,
    restartOnWrite: [],
    beforeWriteReply: null,
    busy: new Set(),
    restarts: [],
    reads: 0,
  }

  const fault = (code: number, reason: string, text: string, data: object = {}) =>
    new RpcFailure(code, text, { litch: reason, text: both(text, `EN ${text}`), ...data })

  const handlers: Record<string, Handler> = {
    'litch/device/settings/read': () => {
      settings.reads++
      return {
        schema: settings.schema,
        snapshot: settings.snapshot,
        inheritedEnv: settings.inheritedEnv,
      }
    },
    'litch/device/settings/write': (params) => {
      const { expectedVersion, edits } = params as {
        expectedVersion: number
        edits: SettingEdit[]
      }
      settings.writes.push({ expectedVersion, edits })
      if (settings.writeFailure) throw settings.writeFailure
      if (expectedVersion !== settings.snapshot.version) {
        throw fault(-32053, 'settingsConflict', '设置已经被别处改过了', {
          snapshot: settings.snapshot,
        })
      }
      const values = { ...settings.snapshot.values }
      const explicit = new Set(settings.snapshot.explicit)
      for (const edit of edits) {
        const declared = settings.schema.settings.find((entry) => entry.key === edit.key)
        if (!declared) throw fault(-32602, 'invalidSetting', '没有这一项', { key: edit.key })
        if (edit.value === null) {
          values[edit.key] = declared.default
          explicit.delete(edit.key)
          continue
        }
        explicit.add(edit.key)
        // 读出去的时候密钥是遮住的：真的设备服务就是这样
        if ((declared.type as string) === 'secret') values[edit.key] = { set: true }
        else if (Array.isArray(edit.value)) {
          values[edit.key] = edit.value.map((entry) =>
            entry.secret ? { name: entry.name, secret: true } : entry,
          )
        } else values[edit.key] = edit.value
      }
      settings.snapshot = {
        ...settings.snapshot,
        version: settings.snapshot.version + 1,
        values,
        explicit: [...explicit],
      }
      settings.beforeWriteReply?.()
      return {
        snapshot: settings.snapshot,
        changed: edits.map((edit) => edit.key),
        restarted: settings.restartOnWrite,
      }
    },
    'litch/device/harness/restart': (params) => {
      const { harness, force } = params as { harness: string; force?: boolean }
      settings.restarts.push({ harness, force: force === true })
      if (settings.busy.has(harness) && force !== true) {
        throw fault(-32054, 'harnessBusy', `${harness} 有回合在跑`, { harness })
      }
      settings.snapshot = {
        ...settings.snapshot,
        pendingRestart: settings.snapshot.pendingRestart.filter((id) => id !== harness),
      }
      return { harness, state: 'running', text: null, snapshot: settings.snapshot }
    },
    'litch/device/diagnostics/run': (params) => ({
      ranAt: '2026-10-13T08:00:00Z',
      checks: [
        {
          id: 'runtime',
          scope: harnessScope((params as { harness?: string }).harness ?? 'pi'),
          status: 'failed',
          title: both('引擎的命令行', 'Engine CLI'),
          detail: both('没找到', 'Not found'),
          logPath: '/state/pi/diagnostics.log',
        },
      ],
    }),
    'litch/device/logs/read': (params) => {
      const { source, harness } = params as { source: string; harness?: string }
      return {
        path: harness ? `/state/logs/${harness}/${source}.log` : `/state/logs/${source}.log`,
        text: '一行日志\n',
        truncated: true,
        size: 4096,
        directory: '/state/logs',
      }
    },
    'litch/device/sshConfig/read': () => ({
      entries: [
        {
          harness: 'pi',
          alias: 'codex-harness-adapter-pi',
          port: 2200,
          config: null,
          unavailable: both('这个入口关着', 'This entry is off'),
        },
      ],
      text: '',
    }),
  }
  return { settings, handlers }
}
