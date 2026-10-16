import type { RuntimeEvent, ThreadItem } from './types.mjs'

export type HookEvent = Extract<RuntimeEvent, { type: 'hook' }>
export interface HookRun {
  itemId: string
  hookRunId: string
  hookName: string
  hookEvent: string
  phase: HookEvent['phase']
  outcome: HookEvent['outcome'] | 'unknown'
  exitCode: number | null
  stdout: string
  stderr: string
  output: string
  messageIds: string[]
  explanation: string | null
}

export function hookItem(run: HookRun): Extract<ThreadItem, { type: 'hookPrompt' }> {
  const texts = [`Hook · ${run.hookEvent} · ${run.hookName}`]
  if (run.outcome) texts.push(`结果: ${run.outcome}`)
  if (run.exitCode !== null) texts.push(`退出码: ${run.exitCode}`)
  if (run.explanation) texts.push(run.explanation)
  // SDK 输出是累计快照；stdout/stderr 与合并 output 不重复展示。
  if (run.stdout) texts.push(run.stdout)
  if (run.stderr && run.stderr !== run.stdout) texts.push(run.stderr)
  if (
    run.output &&
    run.output !== run.stdout &&
    run.output !== run.stderr &&
    run.output !== run.stdout + run.stderr &&
    run.output !== `${run.stdout}\n${run.stderr}`
  )
    texts.push(run.output)
  return {
    type: 'hookPrompt',
    id: run.itemId,
    fragments: texts.map((text) => ({ text, hookRunId: run.hookRunId })),
  }
}
