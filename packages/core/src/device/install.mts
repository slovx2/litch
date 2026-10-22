// 一台设备上给 harness 安装（协议扩展 harnessInstall，14 号设计第二节）在客户端这一头的样子。
// 版本探测、下载、跑官方命令、装完重启都在设备上（适配器的 Go 主进程），核心只是转运：
// - install 主题开着才去问版本（设备详情、新建页“没有可用的 harness”、首启引导）；
// - 安装任务跟着 litch/device/harness/install/changed 走，任务结束（成或不成）后重新问一次版本；
// - 连上、重连时读一次任务（litch/device/harness/install/read）补上状态；原来看着在跑、设备那边已经没有了的，
//   记成 lost（“上次安装没有结束”：设备服务重启或断线时任务随进程没了）。
import {
  HARNESS_INSTALL_METHOD,
  HARNESS_INSTALL_NOTIFICATION,
  type HarnessInstallJob,
  type HarnessVersionInfo,
} from '../../../protocol/src/device-harness-install.mjs'
import type { ClientRequestMethod, ClientRequests } from '../../../protocol/src/index.mjs'
import { ChannelError, type InstallOp } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { RpcRequestOptions } from '../connection/rpc.mjs'
import type {
  HarnessInstallTarget,
  HarnessVersionView,
  InstallJobView,
  InstallTopicView,
} from '../model-install.mjs'
import { engineOf } from './harness.mjs'

export interface InstallHost {
  deviceId: string
  now(): number
  online(): boolean
  /** 对面支不支持：它是设备服务，而且设备信息的 extensions 里列了 harnessInstall */
  supported(): boolean
  request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<ClientRequests[M]['result']>
  /** 请求没做成：换成给人看的错误 */
  fail(error: unknown): ChannelError
  log(line: string): void
}

export interface Install {
  /** 订阅。先给快照，之后给增量；返回退订函数 */
  open(sink: HostSink): () => void
  /** 连上并认出对面是谁了 */
  resync(): void
  /** 连接断了：在途的结果都不算数了 */
  offline(): void
  /** 是安装的通知就处理掉并返回 true */
  notification(method: string, params: unknown): boolean
  /** 问各 harness 的版本（latest：现查最新版） */
  versions(latest: boolean): Promise<HarnessVersionView[]>
  /** 开始装，返回任务号 */
  start(harness: string, version: HarnessInstallTarget): Promise<string>
}

/** 问版本最多等多久：带 latest 时设备要联网（它自己五秒超时），留些余量 */
const VERSIONS_TIMEOUT_MS = 15_000

/**
 * 设备给的是适配器的引擎名（claude-code），聚合面的 HarnessView.id 也是它（harnessFromInfo 原样用），所以不换：
 * 换成单入口模式的 claude 会和设备列着的那一项对不上，引导页、新建页里同一个 harness 出两行
 */
export const projectVersion = (info: HarnessVersionInfo): HarnessVersionView => ({
  harness: info.harness,
  installable: info.installable === true,
  method: info.method ?? null,
  installed: info.installed ?? null,
  minimum: info.minimum ?? null,
  verified: info.verified ?? null,
  latest: info.latest ?? null,
  latestError: info.latestError ?? null,
  docsUrl: info.docsUrl ?? '',
  manual: info.manual ?? '',
})

export const projectJob = (job: HarnessInstallJob): InstallJobView => ({
  job: job.job,
  harness: job.harness,
  version: job.version,
  resolved: job.resolved ?? null,
  state: job.state,
  command: job.command ?? '',
  log: Array.isArray(job.log) ? job.log.slice(-200) : [],
  startedAt: job.startedAt,
  endedAt: job.endedAt ?? null,
  installed: job.installed ?? null,
  failure: job.failure ?? null,
})

export function createInstall(host: InstallHost): Install {
  const sinks = new Set<HostSink>()
  let available: boolean | null = null
  let versions: HarnessVersionView[] | null = null
  let loading: InstallTopicView['loading'] = null
  let error: InstallTopicView['error'] = null
  /** 每个 harness 最近一次的任务 */
  const jobs = new Map<string, InstallJobView>()
  /** 每次连上、断开换一个代号：回来的结果不是这一轮的就作废 */
  let epoch = 0

  const view = (): InstallTopicView => ({
    deviceId: host.deviceId,
    available,
    versions,
    loading,
    error,
    jobs: [...jobs.values()],
  })

  const emit = () => {
    const ops: InstallOp[] = [{ op: 'install.set', view: view() }]
    for (const sink of sinks) sink.delta(ops)
  }

  const reachable = () => {
    if (!host.online()) throw new ChannelError('offline', '设备未连接')
    if (!host.supported()) throw new ChannelError('unsupported', '此设备的服务不支持安装 harness')
  }

  const loadVersions = async (latest: boolean): Promise<HarnessVersionView[]> => {
    reachable()
    const mine = epoch
    loading = latest ? 'latest' : 'versions'
    emit()
    try {
      const response = await host.request(
        HARNESS_INSTALL_METHOD.versions,
        latest ? { latest: true } : {},
        { timeoutMs: VERSIONS_TIMEOUT_MS },
      )
      const next = (Array.isArray(response?.harnesses) ? response.harnesses : []).map(
        projectVersion,
      )
      if (mine === epoch) {
        versions = next
        error = null
        loading = null
        emit()
      }
      return next
    } catch (thrown) {
      const failed = host.fail(thrown)
      if (mine === epoch) {
        loading = null
        error = failed.toShape()
        emit()
      }
      throw failed
    }
  }

  /** 读设备上的任务。原来看着在跑、这次没读到的记成 lost */
  const readJobs = async () => {
    const mine = epoch
    const response = await host.request(HARNESS_INSTALL_METHOD.read, {})
    if (mine !== epoch) return
    const seen = new Set<string>()
    for (const raw of Array.isArray(response?.jobs) ? response.jobs : []) {
      const job = projectJob(raw)
      seen.add(job.job)
      const was = jobs.get(job.harness)
      // 同一个 harness 只留最近的那一次
      if (!was || was.job === job.job || was.startedAt <= job.startedAt) jobs.set(job.harness, job)
    }
    for (const [harness, job] of jobs) {
      if (job.state === 'running' && !seen.has(job.job)) {
        jobs.set(harness, { ...job, state: 'lost', endedAt: host.now() })
      }
    }
    emit()
  }

  const refresh = () => {
    loadVersions(false).catch((thrown: unknown) =>
      host.log(`问 harness 的版本失败：${String(thrown)}`),
    )
    readJobs().catch((thrown: unknown) => host.log(`读安装任务失败：${String(thrown)}`))
  }

  return {
    open(sink) {
      sinks.add(sink)
      sink.snapshot(view())
      if (versions === null && loading === null && host.online() && host.supported()) refresh()
      return () => {
        sinks.delete(sink)
      }
    },

    resync() {
      epoch++
      available = host.supported()
      versions = null
      loading = null
      error = null
      // 断开之前看着在跑的任务先留着：读到任务之后再判断它还在不在
      emit()
      if (available && sinks.size > 0) refresh()
      else if (available && [...jobs.values()].some((job) => job.state === 'running')) {
        readJobs().catch((thrown: unknown) => host.log(`读安装任务失败：${String(thrown)}`))
      }
    },

    offline() {
      epoch++
      loading = null
      emit()
    },

    notification(method, params) {
      if (method !== HARNESS_INSTALL_NOTIFICATION.changed) return false
      const raw = params as HarnessInstallJob | null
      if (!raw || typeof raw.job !== 'string' || typeof raw.harness !== 'string') return true
      const job = projectJob(raw)
      const was = jobs.get(job.harness)
      jobs.set(job.harness, job)
      emit()
      // 刚结束：装上了什么版本、它现在能不能用，重新探测一次（harness 自己的状态设备另外发通知）
      const ended =
        job.state !== 'running' && (!was || was.job !== job.job || was.state === 'running')
      if (ended && host.online() && host.supported()) {
        loadVersions(false).catch((thrown: unknown) =>
          host.log(`装完重新问版本失败：${String(thrown)}`),
        )
      }
      return true
    },

    versions: (latest) => loadVersions(latest),

    async start(harness, version) {
      reachable()
      let response: { job: string }
      try {
        response = await host.request(HARNESS_INSTALL_METHOD.install, {
          harness: engineOf(harness),
          version,
        })
      } catch (thrown) {
        throw host.fail(thrown)
      }
      const id = String(response?.job ?? '')
      // 进度的通知可能比应答先到：已经有了就不放占位的
      if (jobs.get(harness)?.job !== id) {
        jobs.set(harness, {
          job: id,
          harness,
          version,
          resolved: null,
          state: 'running',
          command: '',
          log: [],
          startedAt: host.now(),
          endedAt: null,
          installed: null,
          failure: null,
        })
        emit()
      }
      return id
    },
  }
}
