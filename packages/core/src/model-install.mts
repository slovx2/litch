// 给设备装 harness 在界面这一头的样子（设备的 harnessInstall 扩展投影过来的）。
// 版本和安装任务都在设备上，核心只是转运：install 主题开着（设备详情、新建页的“没有可用的 harness”、首启引导）
// 才去问版本；安装任务跟着 litch/device/harness/install/changed 走。
import type {
  HarnessInstallMethod,
  HarnessInstallTarget,
} from '../../protocol/src/device-harness-install.mjs'
import type { ChannelErrorShape } from './channel/protocol.mjs'
import type { Bilingual } from './model.mjs'

export type { HarnessInstallMethod, HarnessInstallTarget }

/** 一个 harness 的版本情况（和协议的 HarnessVersionInfo 同形，原因换成界面认的两种语言） */
export interface HarnessVersionView {
  /** harness 的标识，和 HarnessView.id 一样（Claude Code 是 claude，不是适配器的引擎名 claude-code） */
  harness: string
  /** 能不能由 Litch 装。自填命令的 acp、这个系统上没有官方方式的都是 false */
  installable: boolean
  method: HarnessInstallMethod | null
  /** 探测到的已装版本；没装、探测不出是 null */
  installed: string | null
  /** 适配器要求的最低版本；没有要求是 null */
  minimum: string | null
  /** 我们验证过的版本；没有记录是 null（界面上只给最新版并标“未验证”） */
  verified: string | null
  /** 最新版；没查、查不到是 null */
  latest: string | null
  /** 查最新版失败的原因 */
  latestError: Bilingual | null
  /** 官方安装说明的地址 */
  docsUrl: string
  /** 给人复制的官方安装命令 */
  manual: string
}

/**
 * 一次安装任务。state 比协议多一种 lost：核心看着它在跑，连接断了（设备服务重启、断线）回来之后设备那边已经没有它了，
 * 界面说“上次安装没有结束”，按重新探测的版本决定接下来显示什么
 */
export interface InstallJobView {
  job: string
  /** 同 HarnessVersionView.harness */
  harness: string
  version: HarnessInstallTarget
  /** 实际要装的版本号；还不知道是 null */
  resolved: string | null
  state: 'running' | 'succeeded' | 'failed' | 'lost'
  /** 真正跑的那条命令 */
  command: string
  /** 命令输出的末尾，最多 200 行 */
  log: string[]
  startedAt: number
  endedAt: number | null
  /** 装好后重新探测到的版本 */
  installed: string | null
  /** 失败的原因一句话（设备给的两种语言） */
  failure: Bilingual | null
}

/**
 * install 主题的快照：一台设备上各 harness 的版本情况和安装任务。
 * available：设备列没列 harnessInstall。还没连上过是 null；false 时界面退回原来的说明（复制命令、去设备上装）
 */
export interface InstallTopicView {
  deviceId: string
  available: boolean | null
  /** 各 harness 的版本。还没问到（没连上、不支持、正在问）是 null */
  versions: HarnessVersionView[] | null
  /** 正在问版本（latest：这一次带着现查最新版） */
  loading: 'versions' | 'latest' | null
  /** 上一次问版本没问成的原因（界面按 whyNot 说）。问成了清掉 */
  error: ChannelErrorShape | null
  /** 每个 harness 最近一次的安装任务（在跑的、刚结束的、断线丢了的） */
  jobs: InstallJobView[]
}
