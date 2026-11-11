// 开始子会话时模型越级（高于父会话、或有一方未分级）：从错误里取出设备给的结构，
// 列出能改用的模型。桌面和手机共用；文字由设备给的那一句（Phrase）按界面语言说。
import type { ModelLimitFailureView, ModelLimitSettingsTarget } from '@litch/core'

export type { ModelLimitFailureView, ModelLimitSettingsTarget }

/** 这个错误是不是模型越级；不是就是 null，照一般的失败原因说 */
export function modelLimitOf(error: unknown): ModelLimitFailureView | null {
  if (!error || typeof error !== 'object') return null
  return (error as { modelLimit?: ModelLimitFailureView }).modelLimit ?? null
}

export interface AllowedChoice {
  harness: string
  model: string
  name: string
}

/** 能改用的模型：设备算好的（带名字）在前，只有 ID 的补在后面，不重复 */
export function allowedChoices(limit: ModelLimitFailureView): AllowedChoice[] {
  const { allowed, allowedModels, child } = limit.reason
  const choices: AllowedChoice[] = allowed.map((model) => ({
    harness: model.harness,
    model: model.model,
    name: model.name || model.model,
  }))
  for (const model of allowedModels)
    if (!choices.some((choice) => choice.model === model))
      choices.push({ harness: child.harness, model, name: model })
  return choices
}

/** 默认选哪一个：父会话自己的模型（同级、最接近原意）在里面就选它，否则选第一个 */
export function defaultChoice(limit: ModelLimitFailureView, choices: AllowedChoice[]): string {
  const parent = limit.reason.parentModel
  return (choices.find((choice) => choice.model === parent) ?? choices[0])?.model ?? ''
}

/** 跳转按钮的文案键：改经理默认模型、调整模型等级 */
export const LIMIT_TARGET_TEXT = {
  'manager-default-model': 'limit.manager',
  'model-ranking': 'limit.ranking',
} as const satisfies Record<ModelLimitSettingsTarget['kind'], string>
