// 结束了的命令那一行右边写什么：耗时、状态，状态标不标红。不靠浏览器，单测在 test/command-state.test.mjs。
import type { CommandItem } from '@litch/core'
import type { Translator } from '../i18n/index.ts'

/** 状态那几个字：运行中、已拒绝、通过、退出码几、失败 */
export function commandState(item: CommandItem, t: Translator): string {
  if (item.status === 'inProgress') return t('command.running')
  if (item.status === 'declined') return t('status.declined')
  if (item.exitCode === 0) return t('command.passed')
  return item.exitCode === null
    ? t('status.failed')
    : t('command.exitCode', { code: item.exitCode })
}

/**
 * 写不写耗时（null 是不写）、状态标不标红。拒绝了的命令没跑过：不写耗时、不标红，退出码不看。
 * 上游现在给的拒绝条目这几项本来就是空的，但重读旧版 codex 记下的会话时给的是退出码 -1、时长 0
 *（rust-v0.162.0-alpha.20 的 thread_history.rs，reconstructs_declined_exec_and_patch_items），那不是命令的结果
 */
export function commandLook(item: CommandItem): { durationMs: number | null; failed: boolean } {
  if (item.status === 'declined') return { durationMs: null, failed: false }
  return {
    durationMs: item.durationMs,
    failed: item.status === 'failed' || (item.exitCode !== null && item.exitCode !== 0),
  }
}
