// 模拟核心的 harness 详情设置（15 号设计）：每台设备每个 harness 一份示例（sample-hc-*.mts），
// 行为照真的设备和核心：带版本的写入对不上就以 conflict 结束并重读、改了要重启的提示重启、
// 登录的每一步（浏览器回调、设备码、粘贴码、API key）、只认环境变量的密钥写进设备设置、MCP 增删改和 OAuth、
// 指令文件与统一模式（一份真文件、其余软链）、Codex 的模型清单（整份写入、改了要重启）。
// 别的客户端的动静由模拟核心按对话里的关键字来演：“别处改配置”（改了并发来通知）、“抢先改配置”（下次保存冲突），
// “别处改模型清单”（改了模型清单并发来通知）、“锁住模型清单”（管理员锁住、再说一次解开）。
// 登录怎么算成：浏览器那一步过一会儿自己成（当作用户在浏览器里点了同意）；设备码同样；
// 粘贴码填 bad 算失败，别的算成；API key 不以 sk- 或 token 开头算失败。
import {
  ChannelError,
  type Clock,
  type Commands,
  type HarnessConfigOp,
} from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { unifiedOf } from '../device/harness-config.mjs'
import type { DeviceView } from '../model.mjs'
import type {
  HarnessConfigTopicView,
  HcAttempt,
  HcAuthState,
  HcAuthStep,
  HcInstructionsView,
  HcPart,
  HcValue,
  InstructionsLinkResult,
  InstructionsOverview,
} from '../model-harness-config.mjs'
import { copyValue } from '../value.mjs'
import { sampleClaude } from './sample-hc-claude.mjs'
import { CODEX_CALLBACK_PORT, sampleCodex } from './sample-hc-codex.mjs'
import { hashOf, type SampleHc, type SampleHome, t } from './sample-hc-kit.mjs'
import { DSH_CALLBACK_PORT, sampleDsh, sampleOpencode, samplePi } from './sample-hc-others.mjs'

export interface MockHarnessConfigHost {
  clock: Clock
  /** 每一步隔多久的基数；0 表示不拖时间 */
  stepMs: number
  device(deviceId: string): DeviceView | undefined
  /**
   * env 方式：写进设备设置里这个 harness 的环境变量表（mock-manage.mts）。
   * restarted：设备顺手把它重启了（没有回合在跑）；pending：有回合在跑，等着重启
   */
  writeEnv(
    deviceId: string,
    harness: string,
    name: string,
    value: string | null,
  ): { restarted: boolean; pending: boolean }
}

export interface MockHarnessConfig {
  subscribe(deviceId: string, harness: string, sink: HostSink): () => void
  /** 是详情设置的命令就处理；不是就返回 undefined，交给别处 */
  command(name: string, params: unknown): Promise<unknown> | undefined
  /** 这个 harness 重启过了：要重启才生效的用上 */
  restarted(deviceId: string, harness: string): void
  /** 别的客户端改了这台设备上各 harness 的一项配置：有人看着之后过一会儿改，改完发通知 */
  editElsewhere(deviceId: string): void
  /** 别的客户端抢先改了，通知没到：这台设备上下一次带版本的写入冲突 */
  raceNextWrite(deviceId: string): void
  /** 别的客户端过一会儿改了这台设备上 Codex 的模型清单，改完发通知 */
  modelsElsewhere(deviceId: string): void
  /** 这台设备上 Codex 的模型清单被管理员锁住（已经锁着就解开） */
  lockModels(deviceId: string): void
  /** 设备上这个 harness 的状态变了（重启中、起来了）：开着的页面跟着重读（读不到的原因、或者又读得到了） */
  harnessChanged(deviceId: string, harness: string): void
}

const SAMPLES: Record<string, (home: SampleHome) => SampleHc> = {
  codex: sampleCodex,
  claude: sampleClaude,
  opencode: sampleOpencode,
  pi: samplePi,
  dsh: sampleDsh,
}

/** 一个 harness 浏览器登录回调的端口（示例） */
const CALLBACK: Record<string, number> = {
  codex: CODEX_CALLBACK_PORT,
  opencode: CODEX_CALLBACK_PORT,
  pi: CODEX_CALLBACK_PORT,
  dsh: DSH_CALLBACK_PORT,
}

/** 设备上的一份指令文件：真文件有内容，软链指向别的路径 */
interface FileNode {
  content: string | null
  link: string | null
}

interface State {
  deviceId: string
  harness: string
  sample: SampleHc
  sinks: Set<HostSink>
  revision: Record<HcPart, number>
  attempts: Map<string, HcAttempt>
  restartRequired: boolean
  /** 写进了设备设置、还没被 harness 读到（要重启）的环境变量 */
  envPending: Map<string, string | null>
  /** harness 现在读得到的环境变量 */
  envApplied: Map<string, string>
}

const HAS_KEY = /^(sk-|token|tvly-)/

/** 带版本的几块 */
type Versioned = 'config' | 'providers' | 'mcp' | 'models'

export function createMockHarnessConfig(host: MockHarnessConfigHost): MockHarnessConfig {
  const { clock } = host
  const states = new Map<string, State>()
  /** 每台设备上的指令文件：路径 → 内容或软链 */
  const files = new Map<string, Map<string, FileNode>>()
  const elsewhere = new Set<string>()
  const racing = new Set<string>()
  let seq = 0
  const later = (run: () => void, steps: number) =>
    clock.setTimer(run, Math.max(host.stepMs * steps, 1))

  const reach = (deviceId: string, harness: string): State => {
    const device = host.device(deviceId)
    if (!device) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
    if (device.connection !== 'online') throw new ChannelError('offline', '设备没有连上')
    const entry = device.harnesses.find((one) => one.id === harness)
    if (!entry?.configurable || !SAMPLES[harness]) {
      throw new ChannelError('unsupported', `${entry?.name ?? harness} 还不支持详情设置`)
    }
    const key = `${deviceId}:${harness}`
    let state = states.get(key)
    if (!state) {
      const home = device.kind === 'local' ? '/Users/dev' : '/home/dev'
      const sample = (SAMPLES[harness] as (home: SampleHome) => SampleHc)({
        home,
        remote: device.kind !== 'local',
      })
      state = {
        deviceId,
        harness,
        sample,
        sinks: new Set(),
        revision: { config: 0, providers: 0, mcp: 0, instructions: 0, models: 0 },
        attempts: new Map(),
        restartRequired: false,
        envPending: new Map(),
        envApplied: new Map(),
      }
      states.set(key, state)
      // 指令文件放进这台设备的“文件系统”
      const fs = files.get(deviceId) ?? new Map<string, FileNode>()
      files.set(deviceId, fs)
      const info = sample.instructions
      if (!fs.has(info.path))
        fs.set(info.path, { content: info.exists ? info.content : null, link: null })
    }
    return state
  }

  /** 装没装、在不在跑：没在跑的 harness 读不到配置 */
  const running = (state: State): ChannelError | null => {
    const harness = host.device(state.deviceId)?.harnesses.find((one) => one.id === state.harness)
    if (harness?.state === 'ready') return null
    const said = t(
      `${harness?.name ?? state.harness} 现在没在跑（没装或者起不来），读不到它的配置`,
      `${harness?.name ?? state.harness} is not running (not installed or failed to start), so its settings cannot be read`,
    )
    return new ChannelError('remote', said['zh-CN'], undefined, { said })
  }

  const instructionsOf = (state: State): HcInstructionsView => {
    const fs = files.get(state.deviceId) ?? new Map<string, FileNode>()
    const path = state.sample.instructions.path
    const node = fs.get(path) ?? { content: null, link: null }
    const target = node.link ? fs.get(node.link) : null
    const content = node.link ? (target?.content ?? null) : node.content
    return {
      ...state.sample.instructions,
      exists: content !== null,
      content: content ?? '',
      hash: content === null ? '' : hashOf(content),
      linkTarget: node.link,
    }
  }

  const authOf = (state: State, providerId: string): HcAuthState | null => {
    const provider = state.sample.providers.providers.find((one) => one.id === providerId)
    if (!provider) return null
    // env 方式的：harness 读得到这个变量就算登录了
    const envNames = provider.methods.flatMap((one) =>
      one.kind === 'env' && one.envName ? [one.envName] : [],
    )
    const applied = envNames.filter((name) => state.envApplied.has(name))
    if (envNames.length > 0 && !provider.auth.signedIn) {
      return applied.length > 0
        ? { signedIn: true, kind: 'env', label: applied.join(', '), detail: null }
        : provider.auth
    }
    return provider.auth
  }

  const view = (state: State): HarnessConfigTopicView => {
    const failed = running(state)
    const slot = <T,>(part: HcPart, data: T) => ({
      data: failed ? null : data,
      loading: false,
      error: failed ? failed.toShape() : null,
      revision: state.revision[part],
    })
    const providers = {
      ...state.sample.providers,
      providers: state.sample.providers.providers.map((one) => ({
        ...one,
        auth: authOf(state, one.id) ?? one.auth,
      })),
    }
    return {
      deviceId: state.deviceId,
      harness: state.harness,
      supported: true,
      config: slot('config', copyValue(state.sample.config)),
      providers: slot('providers', copyValue(providers)),
      mcp: slot('mcp', copyValue(state.sample.mcp)),
      instructions: slot('instructions', instructionsOf(state)),
      models: state.sample.models
        ? slot('models', copyValue(state.sample.models))
        : { data: null, loading: false, error: null, revision: 0 },
      attempts: [...state.attempts.values()].map((one) => copyValue(one)),
      restartRequired: state.restartRequired,
    }
  }

  const publish = (state: State) => {
    if (state.sinks.size === 0) return
    const ops: HarnessConfigOp[] = [{ op: 'hc.set', view: view(state) }]
    for (const sink of state.sinks) sink.delta(ops)
  }

  const conflict = () => {
    const said = t(
      '配置在别处被改过了，已经重新读取。请看着最新的内容再保存一次',
      'The settings were changed elsewhere and have been reloaded. Review the latest values and save again',
    )
    return new ChannelError('conflict', said['zh-CN'], undefined, { said })
  }

  /** 带版本的写入：对不上（或者被“抢先改了”）就冲突 */
  const checkVersion = (state: State, part: Versioned, expected: string) => {
    const failed = running(state)
    if (failed) throw failed
    const current =
      part === 'config'
        ? state.sample.config.version
        : part === 'providers'
          ? state.sample.providers.version
          : part === 'models'
            ? (state.sample.models?.version ?? '')
            : state.sample.mcp.version
    if (racing.has(state.deviceId)) {
      racing.delete(state.deviceId)
      bump(state, part)
      // 别处的改动落下了，通知却没到：这边只是看到冲突、重读之后才看得到
      publish(state)
      throw conflict()
    }
    if (expected !== current) {
      publish(state)
      throw conflict()
    }
  }

  const bump = (state: State, part: Versioned) => {
    const next = (version: string) =>
      `${version.replace(/\d+$/, '')}${Number(version.match(/\d+$/)?.[0] ?? 0) + 1}`
    if (part === 'config') state.sample.config.version = next(state.sample.config.version)
    else if (part === 'providers')
      state.sample.providers.version = next(state.sample.providers.version)
    else if (part === 'models') {
      if (state.sample.models) state.sample.models.version = next(state.sample.models.version)
    } else state.sample.mcp.version = next(state.sample.mcp.version)
  }

  // ---------- 登录 ----------

  const finish = (state: State, attempt: HcAttempt, step: HcAuthStep) => {
    attempt.step = step
    attempt.busy = false
    attempt.forward = attempt.forward && step.kind === 'openUrl' ? attempt.forward : null
    if (step.kind === 'done') {
      if (attempt.providerId) {
        const provider = state.sample.providers.providers.find(
          (one) => one.id === attempt.providerId,
        )
        if (provider) {
          provider.auth = step.auth
          provider.canLogout = true
        }
      } else if (attempt.mcpServer) {
        const server = state.sample.mcp.servers.find((one) => one.name === attempt.mcpServer)
        if (server) server.status = { state: 'connected', message: null }
      }
    }
    publish(state)
  }

  /** 浏览器那一步：远程设备先转发回调端口，过一会儿当作用户点了同意 */
  const browserStep = (state: State, attempt: HcAttempt, port: number, auth: HcAuthState) => {
    const device = host.device(state.deviceId)
    const remote = device?.kind !== 'local'
    attempt.forward = remote ? { port, state: 'opening', message: null } : null
    const ready = () => {
      later(() => {
        if (state.attempts.get(attempt.attemptId) !== attempt || attempt.step.kind !== 'openUrl')
          return
        finish(state, attempt, { kind: 'done', auth })
      }, 60)
    }
    if (remote) {
      later(() => {
        if (state.attempts.get(attempt.attemptId) !== attempt) return
        attempt.forward = { port, state: 'ready', message: null }
        publish(state)
        ready()
      }, 12)
    } else ready()
  }

  const startAuth = (
    state: State,
    providerId: string,
    methodId: string,
    inputs: Record<string, string> | undefined,
  ) => {
    const failed = running(state)
    if (failed) throw failed
    const provider = state.sample.providers.providers.find((one) => one.id === providerId)
    const chosen = provider?.methods.find((one) => one.id === methodId)
    if (!provider || !chosen) throw new ChannelError('notFound', '没有这个 provider 或登录方式')
    if (chosen.kind === 'env') {
      throw new ChannelError('invalid', '环境变量方式不经登录，直接写设备设置')
    }
    const attemptId = `attempt-${++seq}`
    const oauth: HcAuthState = {
      signedIn: true,
      kind: 'oauth',
      label: 'dev@example.com',
      detail: null,
    }
    const attempt: HcAttempt = {
      attemptId,
      providerId,
      mcpServer: null,
      step: { kind: 'failed', message: t('', '') },
      forward: null,
      busy: false,
    }
    state.attempts.set(attemptId, attempt)
    const url = `https://auth.example.com/oauth/authorize?client=${state.harness}&provider=${providerId}&state=${attemptId}`
    if (chosen.kind === 'oauthBrowser') {
      const port = CALLBACK[state.harness] ?? CODEX_CALLBACK_PORT
      attempt.step = {
        kind: 'openUrl',
        url,
        callbackPort: port,
        message: t(
          '在浏览器里授权，完成后这里会自己更新',
          'Authorize in the browser; this updates by itself when done',
        ),
        prompt: [],
      }
      browserStep(state, attempt, port, oauth)
    } else if (chosen.kind === 'oauthDeviceCode') {
      attempt.step = {
        kind: 'deviceCode',
        url: 'https://github.com/login/device',
        userCode: 'WDJB-MJHT',
        message: t(
          '在任意一台设备的浏览器里打开网址、输入这个码',
          'Open the address in any browser and enter this code',
        ),
      }
      later(() => {
        if (state.attempts.get(attemptId) === attempt && attempt.step.kind === 'deviceCode') {
          finish(state, attempt, { kind: 'done', auth: oauth })
        }
      }, 60)
    } else if (chosen.kind === 'oauthPaste') {
      attempt.step = {
        kind: 'openUrl',
        url,
        callbackPort: null,
        message: t(
          '授权之后页面上会给一段授权码，贴到下面',
          'After you authorize, the page shows a code; paste it below',
        ),
        prompt: chosen.fields,
      }
    } else {
      const key = inputs?.apiKey ?? ''
      attempt.step = HAS_KEY.test(key)
        ? {
            kind: 'done',
            auth: { signedIn: true, kind: 'apiKey', label: `…${key.slice(-4)}`, detail: null },
          }
        : {
            kind: 'failed',
            message: t('key 不对：对面拒绝了它（401）', 'The key was rejected (401)'),
          }
      if (attempt.step.kind === 'done') finish(state, attempt, attempt.step)
    }
    publish(state)
    return { attemptId }
  }

  const continueAuth = async (state: State, attemptId: string, inputs: Record<string, string>) => {
    const attempt = state.attempts.get(attemptId)
    if (!attempt) throw new ChannelError('notFound', '这次登录已经不在了')
    attempt.busy = true
    publish(state)
    await new Promise<void>((done) => later(done, 8))
    const code = (inputs.code ?? '').trim()
    if (!code || code === 'bad') {
      finish(state, attempt, {
        kind: 'failed',
        message: t(
          '授权码不对或者过期了，请重新登录',
          'The code is wrong or expired; start the login again',
        ),
      })
      return
    }
    finish(state, attempt, {
      kind: 'done',
      auth: { signedIn: true, kind: 'oauth', label: 'dev@example.com', detail: null },
    })
  }

  // ---------- 指令文件 ----------

  const overview = (deviceId: string): InstructionsOverview => {
    const device = host.device(deviceId)
    if (!device) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
    const entries = device.harnesses
      .filter((one) => one.configurable && SAMPLES[one.id])
      .map((one) => {
        try {
          const state = reach(deviceId, one.id)
          const failed = running(state)
          if (failed)
            return { harness: one.id, name: one.name, info: null, error: failed.toShape() }
          return { harness: one.id, name: one.name, info: instructionsOf(state), error: null }
        } catch (error) {
          const failed =
            error instanceof ChannelError ? error : new ChannelError('internal', String(error))
          return { harness: one.id, name: one.name, info: null, error: failed.toShape() }
        }
      })
    return { entries, unified: unifiedOf(entries) }
  }

  const touchInstructions = (deviceId: string, except: string | null) => {
    for (const state of states.values()) {
      if (state.deviceId !== deviceId) continue
      if (state.harness !== except) state.revision.instructions++
      publish(state)
    }
  }

  const unify = (deviceId: string, harness: string, content: string): InstructionsLinkResult[] => {
    const seen = overview(deviceId)
    const source = seen.entries.find((one) => one.harness === harness)?.info
    if (!source) throw new ChannelError('notFound', '读不到这个 harness 的指令文件')
    const fs = files.get(deviceId) ?? new Map<string, FileNode>()
    fs.set(source.path, { content, link: null })
    const results: InstructionsLinkResult[] = []
    for (const entry of seen.entries) {
      if (entry.harness === harness || !entry.info) continue
      const node = fs.get(entry.info.path)
      const backup =
        node && node.link !== source.path && (node.content !== null || node.link)
          ? `${entry.info.path}.litch-backup-20261019`
          : null
      fs.set(entry.info.path, { content: null, link: source.path })
      results.push({ path: entry.info.path, outcome: 'linked', backup })
    }
    touchInstructions(deviceId, null)
    return results
  }

  const separate = (deviceId: string): string[] => {
    const seen = overview(deviceId)
    if (!seen.unified) return []
    const fs = files.get(deviceId) ?? new Map<string, FileNode>()
    const content = fs.get(seen.unified.sourcePath)?.content ?? ''
    const separated: string[] = []
    for (const [path, node] of fs) {
      if (node.link === seen.unified.sourcePath) {
        fs.set(path, { content, link: null })
        separated.push(path)
      }
    }
    touchInstructions(deviceId, null)
    return separated
  }

  // ---------- 别处的动静 ----------

  const arm = (deviceId: string) => {
    if (!elsewhere.has(deviceId)) return
    elsewhere.delete(deviceId)
    later(() => {
      for (const state of states.values()) {
        if (state.deviceId !== deviceId || running(state)) continue
        // 改的是“默认模型”那一组里第一项能写的开关或单选：挑一个看得出来的
        const target = state.sample.config.settings.find(
          (one) =>
            !one.readOnly &&
            (one.type === 'boolean' || one.type === 'enum') &&
            one.options.length !== 1,
        )
        if (!target) continue
        const current = state.sample.config.values[target.key] ?? target.default
        state.sample.config.values[target.key] =
          target.type === 'boolean'
            ? current !== true
            : (target.options.find((one) => one.value !== current)?.value ?? current)
        bump(state, 'config')
        state.revision.config++
        publish(state)
      }
    }, 30)
  }

  /**
   * 别处改模型清单：等这台设备上 Codex 的详情设置开着之后过几秒再改（留时间让人先动手改出草稿），改完发通知。
   * 不拖时间（stepMs 为 0，测试里）时马上改
   */
  const modelsPending = new Set<string>()
  const armModels = (deviceId: string) => {
    const state = codexOn(deviceId)
    if (!state || state.sinks.size === 0 || !modelsPending.has(deviceId)) return
    modelsPending.delete(deviceId)
    clock.setTimer(
      () => {
        const models = state.sample.models
        if (!models) return
        // 自定义着的：头两项换个位置；还在用自带目录的：改成只留自带目录的头三项
        if (models.custom && models.entries.length > 1) {
          const [first, second, ...rest] = models.entries
          models.entries = [second, first, ...rest].filter((one) => one !== undefined)
        } else {
          models.custom = true
          models.entries = models.bases.slice(0, 3).map((one) => ({
            id: one.id,
            displayName: null,
            contextWindow: null,
            base: one.id,
          }))
        }
        bump(state, 'models')
        state.revision.models++
        publish(state)
      },
      host.stepMs === 0 ? 1 : 4000,
    )
  }

  /** 这台设备上的 Codex（详情设置读得到时） */
  const codexOn = (deviceId: string): State | undefined => {
    try {
      return reach(deviceId, 'codex')
    } catch {
      return undefined
    }
  }

  const of = (params: unknown) => {
    const { deviceId, harness } = params as { deviceId: string; harness: string }
    return reach(String(deviceId), String(harness))
  }

  const handlers: Record<string, (params: unknown) => unknown> = {
    'harnessConfig.write': (params) => {
      const p = params as Commands['harnessConfig.write']['params']
      const state = of(p)
      checkVersion(state, 'config', p.expectedVersion)
      const { config } = state.sample
      let restart = false
      for (const edit of p.edits) {
        const one = config.settings.find((entry) => entry.key === edit.key)
        if (!one)
          throw new ChannelError('notFound', `没有这一项：${edit.key}`, undefined, {
            key: edit.key,
          })
        if (one.readOnly) {
          const said = one.readOnlyReason ?? t('这一项是只读的', 'This setting is read-only')
          throw new ChannelError('rejected', said['zh-CN'], undefined, { said, key: edit.key })
        }
        if (one.type === 'integer' || one.type === 'number') {
          const value = edit.value
          if (
            value !== null &&
            (typeof value !== 'number' ||
              (one.type === 'integer' && !Number.isInteger(value)) ||
              (one.minimum !== null && value < one.minimum) ||
              (one.maximum !== null && value > one.maximum))
          ) {
            const said = t(
              `${one.title['zh-CN']} 不在允许的范围里`,
              `${one.title.en} is out of range`,
            )
            throw new ChannelError('invalid', said['zh-CN'], undefined, { said, key: edit.key })
          }
        }
      }
      for (const edit of p.edits) {
        const one = config.settings.find((entry) => entry.key === edit.key)
        if (edit.value === null) {
          delete config.values[edit.key]
          delete state.sample.secrets[edit.key]
        } else if (one?.type === 'secret') {
          state.sample.secrets[edit.key] = String(edit.value)
          config.values[edit.key] = { set: true }
        } else config.values[edit.key] = edit.value as HcValue
        delete config.overridden[edit.key]
        if (one?.effect === 'harness') restart = true
      }
      bump(state, 'config')
      if (restart) state.restartRequired = true
      publish(state)
      return { overriddenKeys: [], restartRequired: restart }
    },
    'harnessConfig.action': (params) => {
      const p = params as Commands['harnessConfig.action']['params']
      const state = of(p)
      if (!state.sample.config.actions.some((one) => one.id === p.actionId)) {
        throw new ChannelError('notFound', `没有这个动作：${p.actionId}`)
      }
      return new Promise((done) => later(() => done({}), 10))
    },
    'harnessConfig.reload': (params) => {
      publish(of(params))
      return {}
    },
    'harnessConfig.providers.upsert': (params) => {
      const p = params as Commands['harnessConfig.providers.upsert']['params']
      const state = of(p)
      checkVersion(state, 'providers', p.expectedVersion)
      const { providers } = state.sample
      const template = providers.templates.find((one) => one.id === p.templateId)
      if (!template) throw new ChannelError('notFound', `没有这个模板：${p.templateId}`)
      if (!/^[A-Za-z0-9_-]+$/.test(p.providerId)) {
        const said = t(
          '标识只能有字母、数字、- 和 _',
          'The id may only contain letters, digits, - and _',
        )
        throw new ChannelError('invalid', said['zh-CN'], undefined, { said, key: 'providerId' })
      }
      const was = providers.providers.find((one) => one.id === p.providerId)
      if (was && was.kind !== 'custom') {
        throw new ChannelError('rejected', '自带的 provider 不能改')
      }
      const definition: Record<string, HcValue> = { ...(was?.definition ?? {}) }
      for (const one of template.fields) {
        const value = p.definition[one.key]
        if (one.type === 'secret') {
          if (typeof value === 'string' && value) {
            state.sample.secrets[`${p.providerId}.${one.key}`] = value
            definition[one.key] = { set: true }
          } else if (!(one.key in definition)) definition[one.key] = { set: false }
        } else if (value !== undefined) definition[one.key] = value
      }
      const named = definition.name ?? definition.title
      const name = typeof named === 'string' && named ? named : p.providerId
      const keyed = Object.values(definition).some(
        (value) =>
          typeof value === 'object' && value !== null && (value as { set?: boolean }).set === true,
      )
      const next = {
        id: p.providerId,
        title: { 'zh-CN': name, en: name },
        kind: 'custom' as const,
        auth: keyed
          ? { signedIn: true, kind: 'apiKey' as const, label: null, detail: null }
          : (was?.auth ?? { signedIn: false, kind: 'none' as const, label: null, detail: null }),
        methods: was?.methods ?? [],
        active: was?.active ?? false,
        definition,
        templateId: p.templateId,
        canLogout: keyed,
      }
      providers.providers = was
        ? providers.providers.map((one) => (one.id === p.providerId ? next : one))
        : [...providers.providers, next]
      bump(state, 'providers')
      publish(state)
      return { restartRequired: false }
    },
    'harnessConfig.providers.discoverModels': (params) => {
      const p = params as Commands['harnessConfig.providers.discoverModels']['params']
      const { providers } = of(p).sample
      const was = providers.providers.find((one) => one.id === p.providerId)
      if (!was) throw new ChannelError('notFound', `没有这个 provider：${p.providerId}`)
      const template = providers.templates.find((one) => one.id === was.templateId)
      if (!template?.discoverModels) throw new ChannelError('rejected', '这个 provider 不能拉型号')
      if (!was.auth.signedIn) throw new ChannelError('rejected', '先填密钥')
      return {
        models: [
          { id: 'deepseek-v4', title: 'DeepSeek V4', contextWindow: 1_000_000 },
          { id: 'deepseek-v4-flash', title: null, contextWindow: null },
          { id: 'deepseek-r2', title: 'DeepSeek R2', contextWindow: 128_000 },
        ],
      }
    },
    'harnessConfig.providers.remove': (params) => {
      const p = params as Commands['harnessConfig.providers.remove']['params']
      const state = of(p)
      const { providers } = state.sample
      const was = providers.providers.find((one) => one.id === p.providerId)
      if (!was) throw new ChannelError('notFound', `没有这个 provider：${p.providerId}`)
      if (was.kind !== 'custom') throw new ChannelError('rejected', '自带的 provider 不能删')
      providers.providers = providers.providers.filter((one) => one.id !== p.providerId)
      if (was.active && providers.providers[0]) providers.providers[0].active = true
      bump(state, 'providers')
      publish(state)
      return { restartRequired: false }
    },
    'harnessConfig.providers.activate': (params) => {
      const p = params as Commands['harnessConfig.providers.activate']['params']
      const state = of(p)
      checkVersion(state, 'providers', p.expectedVersion)
      const { providers } = state.sample
      if (!providers.switchable)
        throw new ChannelError('rejected', '这个 harness 没有“当前 provider”')
      if (!providers.providers.some((one) => one.id === p.providerId)) {
        throw new ChannelError('notFound', `没有这个 provider：${p.providerId}`)
      }
      for (const one of providers.providers) one.active = one.id === p.providerId
      bump(state, 'providers')
      publish(state)
      return { restartRequired: false }
    },
    'harnessConfig.auth.start': (params) => {
      const p = params as Commands['harnessConfig.auth.start']['params']
      return startAuth(of(p), p.providerId, p.methodId, p.inputs)
    },
    'harnessConfig.auth.continue': async (params) => {
      const p = params as Commands['harnessConfig.auth.continue']['params']
      await continueAuth(of(p), p.attemptId, p.inputs ?? {})
      return {}
    },
    'harnessConfig.auth.cancel': (params) => {
      const p = params as Commands['harnessConfig.auth.cancel']['params']
      const state = of(p)
      state.attempts.delete(p.attemptId)
      publish(state)
      return {}
    },
    'harnessConfig.auth.dismiss': (params) => {
      const p = params as Commands['harnessConfig.auth.dismiss']['params']
      const state = of(p)
      state.attempts.delete(p.attemptId)
      publish(state)
      return {}
    },
    'harnessConfig.auth.logout': (params) => {
      const p = params as Commands['harnessConfig.auth.logout']['params']
      const state = of(p)
      const provider = state.sample.providers.providers.find((one) => one.id === p.providerId)
      if (!provider) throw new ChannelError('notFound', `没有这个 provider：${p.providerId}`)
      provider.auth = { signedIn: false, kind: 'none', label: null, detail: null }
      provider.canLogout = false
      bump(state, 'providers')
      publish(state)
      return {}
    },
    'harnessConfig.env.set': (params) => {
      const p = params as Commands['harnessConfig.env.set']['params']
      const state = of(p)
      const { restarted, pending } = host.writeEnv(p.deviceId, p.harness, p.name, p.value)
      if (restarted) {
        if (p.value === null) state.envApplied.delete(p.name)
        else state.envApplied.set(p.name, p.value)
      } else {
        state.envPending.set(p.name, p.value)
        state.restartRequired = true
      }
      publish(state)
      return { restartRequired: pending || !restarted }
    },
    'harnessConfig.mcp.upsert': (params) => {
      const p = params as Commands['harnessConfig.mcp.upsert']['params']
      const state = of(p)
      checkVersion(state, 'mcp', p.expectedVersion)
      const { mcp } = state.sample
      const server = copyValue(p.server)
      if (!/^[A-Za-z0-9_.-]+$/.test(server.name)) {
        const said = t(
          '名字只能有字母、数字和 . - _',
          'The name may only contain letters, digits, . - _',
        )
        throw new ChannelError('invalid', said['zh-CN'], undefined, { said, key: 'name' })
      }
      const old = mcp.servers.find((one) => one.name === (p.previousName ?? server.name))
      if (!p.previousName && mcp.servers.some((one) => one.name === server.name)) {
        const said = t(
          `已经有叫 ${server.name} 的服务了`,
          `There is already a server named ${server.name}`,
        )
        throw new ChannelError('invalid', said['zh-CN'], undefined, { said, key: 'name' })
      }
      // 没给的密钥照旧
      for (const name of server.secretKeys) {
        if (!(name in server.env)) server.env[name] = old?.env[name] ?? ''
        else server.env[name] = ''
      }
      server.status = server.enabled
        ? { state: 'connected', message: null }
        : { state: 'disabled', message: null }
      mcp.servers = old
        ? mcp.servers.map((one) => (one === old ? server : one))
        : [...mcp.servers, server]
      bump(state, 'mcp')
      // Codex 的 MCP 改完要重启才连得上新的
      const restart = state.harness === 'codex'
      if (restart) state.restartRequired = true
      publish(state)
      return { restartRequired: restart }
    },
    'harnessConfig.mcp.remove': (params) => {
      const p = params as Commands['harnessConfig.mcp.remove']['params']
      const state = of(p)
      checkVersion(state, 'mcp', p.expectedVersion)
      const { mcp } = state.sample
      if (!mcp.servers.some((one) => one.name === p.name)) {
        throw new ChannelError('notFound', `没有这个服务：${p.name}`)
      }
      mcp.servers = mcp.servers.filter((one) => one.name !== p.name)
      bump(state, 'mcp')
      publish(state)
      return { restartRequired: false }
    },
    'harnessConfig.mcp.login': (params) => {
      const p = params as Commands['harnessConfig.mcp.login']['params']
      const state = of(p)
      if (!state.sample.mcp.oauth)
        throw new ChannelError('unsupported', '这个 harness 的 MCP 没有 OAuth 登录')
      const attemptId = `attempt-${++seq}`
      const port = 33418
      const attempt: HcAttempt = {
        attemptId,
        providerId: null,
        mcpServer: p.name,
        step: {
          kind: 'openUrl',
          url: `https://auth.example.com/mcp/${encodeURIComponent(p.name)}/authorize?state=${attemptId}`,
          callbackPort: port,
          message: null,
          prompt: [],
        },
        forward: null,
        busy: false,
      }
      state.attempts.set(attemptId, attempt)
      browserStep(state, attempt, port, {
        signedIn: true,
        kind: 'oauth',
        label: null,
        detail: null,
      })
      publish(state)
      return { attemptId }
    },
    'harnessConfig.instructions.write': (params) => {
      const p = params as Commands['harnessConfig.instructions.write']['params']
      const state = of(p)
      const failed = running(state)
      if (failed) throw failed
      const now = instructionsOf(state)
      if (p.expectedHash !== now.hash) throw conflict()
      const fs = files.get(state.deviceId) ?? new Map<string, FileNode>()
      const node = fs.get(now.path)
      // 软链：写进它指着的那份
      fs.set(node?.link ?? now.path, { content: p.content, link: null })
      touchInstructions(state.deviceId, state.harness)
      return { hash: hashOf(p.content) }
    },
    'harnessConfig.models.write': (params) => {
      const p = params as Commands['harnessConfig.models.write']['params']
      const state = of(p)
      const models = state.sample.models
      if (!models) throw new ChannelError('unsupported', '这个 harness 没有模型清单')
      checkVersion(state, 'models', p.expectedVersion)
      if (models.readOnlyReason) {
        const said = models.readOnlyReason
        throw new ChannelError('rejected', said['zh-CN'], undefined, { said })
      }
      if (p.entries === null) {
        models.custom = false
        models.entries = []
      } else {
        const bad = (zh: string, en: string, key: string) => {
          const said = t(zh, en)
          return new ChannelError('invalid', said['zh-CN'], undefined, { said, key })
        }
        if (p.entries.length === 0) {
          throw bad('清单不能是空的', 'The list cannot be empty', 'entries')
        }
        const seen = new Set<string>()
        for (const entry of p.entries) {
          if (!entry.id.trim()) throw bad('模型名不能是空的', 'The model name is empty', 'id')
          if (seen.has(entry.id)) {
            throw bad(`模型名 ${entry.id} 重复了`, `Model name ${entry.id} is repeated`, 'id')
          }
          seen.add(entry.id)
          if (!models.bases.some((one) => one.id === entry.base)) {
            throw bad(`没有 ${entry.base} 这个模型`, `There is no model ${entry.base}`, 'base')
          }
          const window = entry.contextWindow
          if (window !== null && !(Number.isInteger(window) && window > 0)) {
            throw bad(
              '上下文窗口要是正整数',
              'The context window must be a positive integer',
              'contextWindow',
            )
          }
        }
        models.custom = true
        models.entries = copyValue(p.entries)
      }
      bump(state, 'models')
      state.restartRequired = true
      publish(state)
      return { restartRequired: true }
    },
    'instructions.overview': (params) =>
      overview(String((params as { deviceId: string }).deviceId)),
    'instructions.unify': (params) => {
      const p = params as Commands['instructions.unify']['params']
      return { results: unify(p.deviceId, p.harness, p.content) }
    },
    'instructions.separate': (params) => {
      const p = params as Commands['instructions.separate']['params']
      return { separated: separate(p.deviceId) }
    },
  }

  return {
    subscribe(deviceId, harness, sink) {
      const device = host.device(deviceId)
      if (!device) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
      const entry = device.harnesses.find((one) => one.id === harness)
      if (device.connection !== 'online' || !entry?.configurable || !SAMPLES[harness]) {
        // 不支持、没连上：照样成立，快照里说清楚
        const empty = { data: null, loading: false, error: null, revision: 0 }
        sink.snapshot({
          deviceId,
          harness,
          supported: device.connection === 'online' ? false : null,
          config: empty,
          providers: empty,
          mcp: empty,
          instructions: empty,
          models: empty,
          attempts: [],
          restartRequired: false,
        } satisfies HarnessConfigTopicView)
        return () => {}
      }
      const state = reach(deviceId, harness)
      state.sinks.add(sink)
      sink.snapshot(view(state))
      arm(deviceId)
      armModels(deviceId)
      return () => {
        state.sinks.delete(sink)
      }
    },

    command(name, params) {
      const handler = handlers[name]
      if (!handler) return undefined
      return (async () => handler(params))()
    },

    restarted(deviceId, harness) {
      const state = states.get(`${deviceId}:${harness}`)
      if (!state) return
      for (const [name, value] of state.envPending) {
        if (value === null) state.envApplied.delete(name)
        else state.envApplied.set(name, value)
      }
      state.envPending.clear()
      state.restartRequired = false
      publish(state)
    },

    editElsewhere(deviceId) {
      elsewhere.add(deviceId)
      if (
        [...states.values()].some((state) => state.deviceId === deviceId && state.sinks.size > 0)
      ) {
        arm(deviceId)
      }
    },

    raceNextWrite(deviceId) {
      racing.add(deviceId)
    },

    modelsElsewhere(deviceId) {
      modelsPending.add(deviceId)
      armModels(deviceId)
    },

    lockModels(deviceId) {
      const models = codexOn(deviceId)?.sample.models
      if (!models) return
      models.readOnlyReason = models.readOnlyReason
        ? null
        : t(
            '管理员的 requirements.toml 固定了 model_catalog_json',
            'model_catalog_json is pinned by your admin in requirements.toml',
          )
      const state = codexOn(deviceId)
      if (state) publish(state)
    },

    harnessChanged(deviceId, harness) {
      const state = states.get(`${deviceId}:${harness}`)
      if (state && state.sinks.size > 0) publish(state)
    },
  }
}
