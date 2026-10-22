// 远程设备服务的一键升级在那台机器上做的三件事：看一眼装着的是哪一份、装新版、请服务停下。
// 用的是和连接同一套 ssh 参数（args.mts、run.mts），脚本在 script.mts。
// 什么时候做、做完之后怎么办（等空闲、重连、再试）由核心定（packages/core/src/device/service-upgrade.mts），
// 这里只跑脚本、把报回来的字读成结果；用户没确认过，核心不会叫 install 和 stop。
// 解析是单独的几个函数：只看报回来的字，和 ssh 无关，自检里直接喂字就能验。
import type {
  RemoteAdapterFacts,
  RemoteInstallMethod,
  RemoteInstallResult,
  RemoteStopResult,
  RemoteUpgradePlatform,
} from '@litch/core'
import { parseBusy } from '../adapter-upgrade.mjs'
import { notInstalled } from './probe.mjs'
import { fields, type RunResult, runRemote, tailOf } from './run.mjs'
import { EXIT, installScript, probeScript, type RemoteLang, stopScript } from './script.mjs'

/** 看一眼和探测一样宽 */
const INSPECT_TIMEOUT_MS = 45_000
/** 安装脚本要下载几十兆的发布包；Homebrew 没有现成的瓶子时要从源码构建，给得更宽 */
const INSTALL_TIMEOUT_MS = { script: 10 * 60_000, brew: 30 * 60_000 } as const
/** device-stop 自己最多等 40 秒的应答、45 秒的退出，这里留得比它长 */
const STOP_TIMEOUT_MS = 120_000
/** 远端的原话最多留这么多字（末尾） */
const SAID_MAX = 4000

const said = (text: string | undefined): string | null => text?.trim().slice(-SAID_MAX) || null

/** 没见到标记：内层脚本没跑起来（登录 shell 半路退了之类），只能照 ssh 的报错说 */
const unmarked = (result: RunResult): string | null => tailOf(result.stderr)

/** 版本那一行（`codex-harness-adapter 0.16.0`）里的版本号 */
const versionOf = (line: string | undefined): string | null =>
  line?.match(/^codex-harness-adapter\s+(\S+)/)?.[1] ?? null

/** 探测脚本报回来的字 → 装着的那一份在哪、是哪一版 */
export function readFacts(out: Record<string, string>): RemoteAdapterFacts {
  if (out.adapter !== 'yes') return { version: null, path: null }
  return { version: versionOf(out.adapterVersion), path: out.adapterPath?.trim() || null }
}

/** 安装脚本报回来的字 → 结果。没走到 step= 的（半路断了）算安装那一步没成 */
export function readInstall(
  out: Record<string, string>,
  method: RemoteInstallMethod,
): RemoteInstallResult {
  const code = out.code === undefined ? null : Number(out.code)
  const step = out.step
  const installed = versionOf(out.installed)
  if (step === 'verify' && code === 0 && installed)
    return { ok: true, installed, said: said(out.said) }
  const at =
    step === 'fetch' ||
    step === 'download' ||
    step === 'install' ||
    step === 'brew' ||
    step === 'verify'
      ? step
      : method === 'brew'
        ? 'brew'
        : 'install'
  return { ok: false, at, code: Number.isFinite(code) ? code : null, said: said(out.said) }
}

/** 停服务的脚本报回来的字 → 结果。退出码的含义见 cmd/codex-harness-adapter/device_stop.go */
export function readStop(out: Record<string, string>): RemoteStopResult {
  switch (out.code) {
    case '0':
      return { result: 'stopped' }
    case '4':
      // 连着的客户端不算要等的事（stopScript 里只因为它们不闲时已经直接停了），不列出来
      return {
        result: 'busy',
        busy: parseBusy(out.out ?? '').filter((entry) => entry.reason !== 'clients'),
      }
    case '3':
      return { result: 'legacy', said: said(out.said) }
    case '5':
      return { result: 'unsupported', said: said(out.said) }
    default:
      return { result: 'failed', said: said(out.said) ?? said(out.out) }
  }
}

/** 外壳给核心的那一份。lang：远端命令行说哪种语言，跟界面的 */
export function remoteUpgrade(lang: () => RemoteLang): RemoteUpgradePlatform {
  return {
    async inspect(target, signal) {
      const result = await runRemote(target, probeScript(), {
        signal,
        timeoutMs: INSPECT_TIMEOUT_MS,
      })
      return result.marked ? readFacts(fields(result.out)) : { version: null, path: null }
    },
    async install(target, plan, signal) {
      const result = await runRemote(
        target,
        installScript({ method: plan.method, version: plan.version, lang: lang() }),
        { signal, timeoutMs: INSTALL_TIMEOUT_MS[plan.method] },
      )
      if (!result.marked) {
        return {
          ok: false,
          at: plan.method === 'brew' ? 'brew' : 'download',
          code: result.code,
          said: unmarked(result),
        }
      }
      return readInstall(fields(result.out), plan.method)
    },
    async stop(target, ifIdle, signal) {
      const result = await runRemote(target, stopScript({ ifIdle, lang: lang() }), {
        signal,
        timeoutMs: STOP_TIMEOUT_MS,
      })
      // 刚装好的命令找不到了：照“没装”说，和连接时一样
      if (result.code === EXIT.notFound) throw notInstalled()
      if (!result.marked) return { result: 'failed', said: unmarked(result) }
      return readStop(fields(result.out))
    },
  }
}
