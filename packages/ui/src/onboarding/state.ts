// 首启引导出不出（14 号设计第四节）：只出一次，记在这台电脑的界面里（localStorage 的 litch.onboarding）；
// 点了“打开配置助手”“以后再说”或者右上角的关闭都算完成。设置页“配置助手”一节可以重新打开。
// 自检和截图（地址里带 onboarding=off）一律不自己出，免得盖住它们要点的东西；重新打开照样能开。
// 判断“该不该出”的那几样只有逻辑，测试直接引用（packages/ui/test/onboarding.test.mjs）。
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'litch.onboarding'

/** 引导走到哪一步：先装一个 harness，或者已经有可用的、请配置助手帮忙 */
export type OnboardingStep = 'install' | 'assist'

function readDone(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'done'
  } catch {
    // 读不到就当没走过：最多多出一次
    return false
  }
}

const switchedOff = (): boolean => {
  try {
    return new URLSearchParams(location.search).get('onboarding') === 'off'
  } catch {
    return false
  }
}

/** done：走过了；reopened：设置页里点了重新打开（不管走没走过都出） */
let state = {
  done: typeof window === 'undefined' ? true : readDone() || switchedOff(),
  reopened: false,
}
const listeners = new Set<() => void>()
const publish = (next: typeof state) => {
  state = next
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useOnboardingState = (): typeof state => useSyncExternalStore(subscribe, () => state)

/** 走完了（打开配置助手、以后再说、关掉）：记下来，以后不再自己出 */
export function finishOnboarding(): void {
  try {
    localStorage.setItem(STORAGE_KEY, 'done')
  } catch {
    // 记不下来：这一次照样关掉
  }
  publish({ done: true, reopened: false })
}

/** 设置页里点“重新打开引导” */
export function reopenOnboarding(): void {
  publish({ ...state, reopened: true })
}

/** 本机设备的情况里引导要看的几样 */
export interface LocalFacts {
  /** 本机设备有没有、连没连上 */
  online: boolean
  /** harness 的清单到了没有（连上之后才有） */
  listed: boolean
  /** 有几个可用的 */
  ready: number
}

/**
 * 该不该出、出哪一步：没走过（或者重新打开了），本机连上、harness 清单到了之后才出；
 * 本机一个可用的都没有是第一步“先装一个”，有了是第二步。远程设备不参与判断
 */
export function onboardingStep(
  flags: { done: boolean; reopened: boolean },
  local: LocalFacts | null,
): OnboardingStep | null {
  if (flags.done && !flags.reopened) return null
  if (!local?.online || !local.listed) return null
  return local.ready > 0 ? 'assist' : 'install'
}
