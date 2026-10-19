// 给设备装 harness 的界面里的判断：比版本、给哪个按钮（装验证版、装最新版、更新到最新版）、标不标“未验证”、
// 这一项眼下是什么情形（没得装、正在装、装上了、没装成）。只有逻辑，不引组件和样式，测试直接引用
// （packages/ui/test/install-logic.test.mjs）。
import type {
  HarnessInstallTarget,
  HarnessVersionView,
  InstallJobView,
  InstallTopicView,
} from '@litch/core'

/** 版本里的数字段和预发布标记：1.2.3-rc.1 → [1,2,3] 和 'rc.1' */
const partsOf = (version: string): { nums: number[]; pre: string } => {
  const text = version.trim().replace(/^v/i, '')
  const dash = text.indexOf('-')
  const main = dash === -1 ? text : text.slice(0, dash)
  const pre = dash === -1 ? '' : text.slice(dash + 1)
  return { nums: main.split('.').map((part) => Number.parseInt(part, 10) || 0), pre }
}

/** 比两个版本：a 比 b 新回正数，旧回负数，一样回 0。预发布版比同号的正式版旧 */
export function compareVersions(a: string, b: string): number {
  const left = partsOf(a)
  const right = partsOf(b)
  const length = Math.max(left.nums.length, right.nums.length)
  for (let at = 0; at < length; at++) {
    const diff = (left.nums[at] ?? 0) - (right.nums[at] ?? 0)
    if (diff !== 0) return diff
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre < right.pre ? -1 : 1
}

/** 一个按钮：装哪一种、装上去是哪个版本、是不是“更新到”、要不要标“未验证” */
export interface InstallOffer {
  target: HarnessInstallTarget
  version: string
  update: boolean
  unverified: boolean
}

/** 这一项给哪几个按钮。primary 是显眼的那一个，more 是下拉里的另一个；都没有就是不用装 */
export interface InstallChoice {
  primary: InstallOffer | null
  more: InstallOffer | null
}

const offer = (
  info: HarnessVersionView,
  target: HarnessInstallTarget,
  update: boolean,
): InstallOffer | null => {
  const version = target === 'verified' ? info.verified : info.latest
  if (!version) return null
  return { target, version, update, unverified: target === 'latest' && version !== info.verified }
}

/**
 * 装哪个版本（14 号设计 2.2）：
 * - 没装、或者低于下限：默认装验证版，下拉可选最新版（和验证版不一样时）；没有验证版的只给最新版并标“未验证”；
 * - 装了：最新版比装的新，给“更新到 x.y.z”（装最新版）；不主动降级到验证版，也不提示降级；
 * - 最新版跨了大版本也照给，只标“未验证”。
 */
export function installChoice(info: HarnessVersionView): InstallChoice {
  if (!info.installable) return { primary: null, more: null }
  const { installed, minimum, latest } = info
  const tooOld = installed !== null && minimum !== null && compareVersions(installed, minimum) < 0
  if (installed === null || tooOld) {
    const verified = offer(info, 'verified', tooOld)
    const newest = offer(info, 'latest', tooOld)
    if (!verified) return { primary: newest, more: null }
    const more = newest && newest.version !== verified.version ? newest : null
    return { primary: verified, more }
  }
  if (latest && compareVersions(latest, installed) > 0) {
    return { primary: offer(info, 'latest', true), more: null }
  }
  return { primary: null, more: null }
}

/** 这一项眼下的情形 */
export type InstallPhase =
  /** 设备不能装（没有这个能力、没连上）或者还不知道 */
  | 'unknown'
  /** 这个系统上没有官方方式、自填命令的：只能照说明自己装 */
  | 'manual'
  | 'running'
  /** 别的 harness 正在装：这一项先等着 */
  | 'waiting'
  | 'failed'
  /** 刚装上 */
  | 'done'
  /** 可以装或更新 */
  | 'offer'
  /** 装着，也不用更新 */
  | 'current'

export function jobOf(view: InstallTopicView | undefined, harness: string): InstallJobView | null {
  return view?.jobs.find((job) => job.harness === harness) ?? null
}

/**
 * cleared：用户点过“装好后重新检测”的那次任务。它的失败不再挡着，照重新探到的版本说
 */
export function phaseOf(
  view: InstallTopicView | undefined,
  harness: string,
  cleared: string | null = null,
): InstallPhase {
  const info = view?.versions?.find((entry) => entry.harness === harness)
  if (view?.available !== true || !info) return 'unknown'
  const found = jobOf(view, harness)
  const job = found && found.job === cleared ? null : found
  if (job?.state === 'running') return 'running'
  if (view.jobs.some((other) => other.state === 'running')) return 'waiting'
  if (job && (job.state === 'failed' || job.state === 'lost')) return 'failed'
  if (!info.installable) return 'manual'
  if (job?.state === 'succeeded' && info.installed !== null) return 'done'
  return installChoice(info).primary ? 'offer' : 'current'
}

/** 日志的末尾几行（进行中只看最后几行，展开看全部） */
export const logTail = (log: readonly string[], lines: number): string[] => log.slice(-lines)

/** 正在装的是哪一个（这台设备同一时刻只装一个） */
export const runningJob = (view: InstallTopicView | undefined): InstallJobView | null =>
  view?.jobs.find((job) => job.state === 'running') ?? null
