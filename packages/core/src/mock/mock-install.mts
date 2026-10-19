// 模拟核心的给设备装 harness（14 号设计第二节）：版本情况、开始装、日志一行一行出来、装好后 harness 变可用。
// 行为照真的核心和设备服务：同一台设备同一时刻只跑一个任务（再点回 busy）；没声明 harnessInstall 的设备以
// unsupported 结束、没连上的以 offline 结束；查最新版要一会儿；装完（成或不成）重新给一份版本情况。
// 演回退：Codex 固定装不上（npm 全局目录没有写权限），界面上看得到原因、日志、官方命令和说明链接。
import { ChannelError, type Clock, type Commands, type InstallOp } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { DeviceView, HarnessView } from '../model.mjs'
import type {
  HarnessInstallTarget,
  HarnessVersionView,
  InstallJobView,
  InstallTopicView,
} from '../model-install.mjs'

export interface MockInstallHost {
  clock: Clock
  /** 每一步隔多久的基数；0 表示不拖时间 */
  stepMs: number
  device(deviceId: string): DeviceView | undefined
  /** 装好了：把这台设备上的这个 harness 换成可用的、版本是 version */
  installed(deviceId: string, harness: string, version: string): void
}

export interface MockInstall {
  subscribe(deviceId: string, sink: HostSink): () => void
  /** 是安装的命令就处理；不是就返回 undefined，交给别处 */
  command(name: string, params: unknown): Promise<unknown> | undefined
}

/** 示例里各 harness 的安装方式和版本。按这个顺序列 */
interface Sample {
  harness: string
  method: 'script' | 'npm'
  minimum: string | null
  /** 没有验证版的（只给最新版并标“未验证”）是 null */
  verified: string | null
  latest: string
  docsUrl: string
  manual: string
  /** 演回退：固定装不上 */
  fails?: boolean
}

const SAMPLES: readonly Sample[] = [
  {
    harness: 'claude',
    method: 'script',
    minimum: '2.1.282',
    verified: '2.1.282',
    latest: '2.1.303',
    docsUrl: 'https://code.claude.com/docs/en/setup',
    manual: 'curl -fsSL https://claude.ai/install.sh | bash -s 2.1.282',
  },
  {
    harness: 'pi',
    method: 'npm',
    minimum: '0.99.1',
    verified: '0.99.1',
    // 最新版跨了大版本：照样给，旁边标“未验证”
    latest: '1.0.3',
    docsUrl: 'https://github.com/earendil-works/pi',
    manual: 'npm install -g @earendil-works/pi-coding-agent@0.99.1',
  },
  {
    harness: 'dsh',
    method: 'npm',
    minimum: null,
    verified: '0.2.0-rc.2',
    latest: '0.2.0-rc.2',
    docsUrl: 'https://www.npmjs.com/package/@deepseek-ai/dsh',
    manual: 'npm install -g @deepseek-ai/dsh@0.2.0-rc.2',
  },
  {
    harness: 'codex',
    method: 'npm',
    minimum: '0.157.1',
    verified: '0.160.0',
    latest: '0.164.1',
    docsUrl: 'https://github.com/openai/codex',
    manual: 'npm install -g @openai/codex@0.160.0',
    fails: true,
  },
  {
    harness: 'gemini',
    method: 'npm',
    minimum: null,
    verified: null,
    latest: '0.12.0',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    manual: 'npm install -g @google/gemini-cli',
  },
]

const NAMES: readonly string[] = ['install.versions', 'install.start']

const FAILURE = {
  'zh-CN':
    'npm 没有权限写全局目录（EACCES）。可以换用 nvm 装的 Node，或者照官方说明改 npm 的全局目录后再试。',
  en: 'npm cannot write to its global directory (EACCES). Use a Node installed with nvm, or change the npm prefix as the official guide says, then try again.',
}

const LATEST_ERROR = {
  'zh-CN': '查不到最新版：连不上 npm 注册表（5 秒超时）',
  en: 'Could not check the latest version: npm registry unreachable (5 s timeout)',
}

/** 一次安装的日志：成的和不成的各一份 */
const logOf = (sample: Sample, version: string, command: string): string[] => {
  if (sample.method === 'script') {
    return [
      `$ ${command}`,
      'Setting up Claude Code...',
      `Downloading claude ${version} for darwin-arm64`,
      '######################################################## 100.0%',
      'Verifying checksum... ok',
      `Installing to ~/.local/bin/claude`,
      `✔ Claude Code ${version} installed`,
    ]
  }
  if (sample.fails) {
    return [
      `$ ${command}`,
      'npm warn deprecated node-domexception@1.0.0',
      'npm error code EACCES',
      'npm error syscall mkdir',
      'npm error path /usr/local/lib/node_modules/@openai',
      'npm error errno -13',
      "npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@openai'",
      'npm error The operation was rejected by your operating system.',
    ]
  }
  return [
    `$ ${command}`,
    'npm warn deprecated inflight@1.0.6',
    `added 1 package, and audited ${Math.round(version.length * 37)} packages in 4s`,
    'found 0 vulnerabilities',
  ]
}

export function createMockInstall(host: MockInstallHost): MockInstall {
  const { clock } = host
  const sinks = new Map<string, Set<HostSink>>()
  /** 各设备的视图 */
  const views = new Map<string, InstallTopicView>()
  /** 查过最新版的设备：之后的版本情况都带着最新版 */
  const checkedLatest = new Set<string>()
  let seq = 0

  const step = (n: number) => Math.max(host.stepMs * n, 1)

  const deviceOf = (deviceId: string): DeviceView => {
    const device = host.device(deviceId)
    if (!device) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
    return device
  }

  const viewOf = (deviceId: string): InstallTopicView => {
    const had = views.get(deviceId)
    if (had) return had
    const device = host.device(deviceId)
    const view: InstallTopicView = {
      deviceId,
      available: device ? device.install : null,
      versions: null,
      loading: null,
      error: null,
      jobs: [],
    }
    views.set(deviceId, view)
    return view
  }

  const emit = (deviceId: string, patch: Partial<InstallTopicView>) => {
    const next = { ...viewOf(deviceId), ...patch }
    views.set(deviceId, next)
    const op: InstallOp = { op: 'install.set', view: next }
    for (const sink of sinks.get(deviceId) ?? []) sink.delta([op])
  }

  /** 这台设备上这个 harness 现在装的版本：可用的看它报的版本，不可用的当没装 */
  const installedOf = (harness: HarnessView | undefined): string | null =>
    harness && harness.state !== 'unavailable' ? harness.version : null

  /** 远程设备上演一个“这个系统上没有官方方式”的：gemini 在 Linux 上不给装 */
  const versionsOf = (device: DeviceView): HarnessVersionView[] => {
    const latest = checkedLatest.has(device.id)
    const offlineLatest = device.kind !== 'local'
    return SAMPLES.map((sample) => {
      const installable = !(sample.harness === 'gemini' && device.os === 'linux')
      return {
        harness: sample.harness,
        installable,
        method: installable ? sample.method : null,
        installed: installedOf(device.harnesses.find((entry) => entry.id === sample.harness)),
        minimum: sample.minimum,
        verified: sample.verified,
        // 远程设备演“查不到最新版”：只给验证版，旁边写原因
        latest: latest && !offlineLatest ? sample.latest : null,
        latestError: latest && offlineLatest ? LATEST_ERROR : null,
        docsUrl: sample.docsUrl,
        manual: sample.manual,
      }
    })
  }

  const reachable = (device: DeviceView) => {
    if (!device.install) {
      throw new ChannelError('unsupported', '这台设备的服务不支持安装 harness')
    }
    if (device.connection !== 'online') throw new ChannelError('offline', '设备没连上')
  }

  const loadVersions = (deviceId: string, latest: boolean): Promise<HarnessVersionView[]> => {
    const device = deviceOf(deviceId)
    reachable(device)
    if (latest) checkedLatest.add(deviceId)
    emit(deviceId, { available: true, loading: latest ? 'latest' : 'versions', error: null })
    return new Promise((resolve) => {
      // 查最新版要联网，多等一会儿
      clock.setTimer(
        () => {
          const versions = versionsOf(deviceOf(deviceId))
          emit(deviceId, { versions, loading: null })
          resolve(versions)
        },
        step(latest ? 10 : 2),
      )
    })
  }

  const putJob = (deviceId: string, job: InstallJobView) => {
    const jobs = viewOf(deviceId).jobs.filter((entry) => entry.harness !== job.harness)
    emit(deviceId, { jobs: [...jobs, job] })
  }

  const start = (deviceId: string, harness: string, version: HarnessInstallTarget): string => {
    const device = deviceOf(deviceId)
    reachable(device)
    const sample = SAMPLES.find((entry) => entry.harness === harness)
    if (!sample) throw new ChannelError('invalid', `不认识的 harness：${harness}`)
    if (viewOf(deviceId).jobs.some((job) => job.state === 'running')) {
      throw new ChannelError('busy', '这台设备上已经有一个安装在跑')
    }
    const resolved = version === 'latest' || !sample.verified ? sample.latest : sample.verified
    const command =
      sample.method === 'script'
        ? `curl -fsSL https://claude.ai/install.sh | bash -s ${resolved}`
        : sample.manual.replace(/@[^@\s]+$/, `@${resolved}`)
    const lines = logOf(sample, resolved, command)
    const id = `job-${++seq}`
    let job: InstallJobView = {
      job: id,
      harness,
      version,
      resolved,
      state: 'running',
      command,
      log: [],
      startedAt: clock.now(),
      endedAt: null,
      installed: null,
      failure: null,
    }
    putJob(deviceId, job)
    lines.forEach((line, index) => {
      clock.setTimer(
        () => {
          job = { ...job, log: [...job.log, line] }
          putJob(deviceId, job)
        },
        step(4 * (index + 1)),
      )
    })
    clock.setTimer(
      () => {
        if (sample.fails) {
          job = { ...job, state: 'failed', endedAt: clock.now(), failure: FAILURE }
        } else {
          host.installed(deviceId, harness, resolved)
          job = { ...job, state: 'succeeded', endedAt: clock.now(), installed: resolved }
        }
        putJob(deviceId, job)
        // 和真的一样：结束后重新探测一次
        void loadVersions(deviceId, false).catch(() => {})
      },
      step(4 * (lines.length + 2)),
    )
    return id
  }

  return {
    subscribe(deviceId, sink) {
      deviceOf(deviceId)
      const set = sinks.get(deviceId) ?? new Set<HostSink>()
      sinks.set(deviceId, set)
      set.add(sink)
      const view = viewOf(deviceId)
      sink.snapshot(view)
      // 和真的核心一样：主题开着才去问版本
      const device = host.device(deviceId)
      if (device?.install && device.connection === 'online' && !view.versions && !view.loading) {
        void loadVersions(deviceId, false).catch(() => {})
      }
      return () => set.delete(sink)
    },

    command(name, params) {
      if (!NAMES.includes(name)) return undefined
      if (name === 'install.versions') {
        const p = params as Commands['install.versions']['params']
        return loadVersions(p.deviceId, p.latest === true).then((harnesses) => ({ harnesses }))
      }
      const p = params as Commands['install.start']['params']
      return Promise.resolve().then(() => ({ job: start(p.deviceId, p.harness, p.version) }))
    },
  }
}
