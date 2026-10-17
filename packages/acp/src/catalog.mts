// 会话的模型、强度、模式在 ACP 里有两种报法，这里统一读、统一改：
// - 配置项（configOptions，新的做法）：按 category 认，model 是模型、thought_level 是强度、mode 是模式，
//   改用 session/set_config_option；
// - 老的专用字段：models（session/set_model，SDK 里叫 unstable_setSessionModel）、modes（session/set_mode）。
// 两种都有时以配置项为准（规范说 agent 两种都报时客户端应当只用配置项）。
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'

export interface Catalog {
  configOptions: any[] | null
  models: { currentModelId: string; availableModels: any[] } | null
  modes: { currentModeId: string; availableModes: any[] } | null
}

export interface Choice {
  value: string
  name: string
  description: string | null
}

const select = (catalog: Catalog, category: string): any =>
  (catalog.configOptions ?? []).find(
    (option) => option?.category === category && option?.type === 'select',
  ) ?? null

/** 下拉项里的全部选项，分组的摊平 */
function choices(option: any): Choice[] {
  const flat = (Array.isArray(option?.options) ? option.options : []).flatMap((entry: any) =>
    Array.isArray(entry?.options) ? entry.options : [entry],
  )
  return flat
    .filter((entry: any) => typeof entry?.value === 'string')
    .map((entry: any) => ({
      value: entry.value,
      name: String(entry.name ?? entry.value),
      description: typeof entry.description === 'string' ? entry.description : null,
    }))
}

export function models(catalog: Catalog): Choice[] {
  const option = select(catalog, 'model')
  if (option) return choices(option)
  return (catalog.models?.availableModels ?? [])
    .filter((model: any) => typeof model?.modelId === 'string')
    .map((model: any) => ({
      value: model.modelId,
      name: String(model.name ?? model.modelId),
      description: typeof model.description === 'string' ? model.description : null,
    }))
}

export const efforts = (catalog: Catalog): Choice[] => choices(select(catalog, 'thought_level'))

export function modes(catalog: Catalog): Choice[] {
  const option = select(catalog, 'mode')
  if (option) return choices(option)
  return (catalog.modes?.availableModes ?? [])
    .filter((mode: any) => typeof mode?.id === 'string')
    .map((mode: any) => ({
      value: mode.id,
      name: String(mode.name ?? mode.id),
      description: typeof mode.description === 'string' ? mode.description : null,
    }))
}

export const currentModel = (catalog: Catalog): string | null =>
  select(catalog, 'model')?.currentValue ?? catalog.models?.currentModelId ?? null

export const currentEffort = (catalog: Catalog): string | null =>
  select(catalog, 'thought_level')?.currentValue ?? null

export const currentMode = (catalog: Catalog): string | null =>
  select(catalog, 'mode')?.currentValue ?? catalog.modes?.currentModeId ?? null

/** 计划模式：模式里标识是 plan 的，没有就看名字里带 plan 的。没有就是这个 agent 没有计划模式 */
export function planMode(catalog: Catalog): string | null {
  const all = modes(catalog)
  return (
    all.find((mode) => mode.value === 'plan')?.value ??
    all.find((mode) => /\bplan\b/i.test(mode.name))?.value ??
    null
  )
}

type Send = (method: string, params: unknown) => Promise<any>

/** 换模型。不在 agent 报的清单里的拒绝（-32602），由调用方决定要不要退回默认 */
export async function setModel(send: Send, sessionId: string, catalog: Catalog, model: string) {
  if (!models(catalog).some((choice) => choice.value === model))
    throw new ProtocolError(-32602, `ACP agent 没有模型 ${model}`)
  const option = select(catalog, 'model')
  if (option) {
    const result = await send('session/set_config_option', {
      sessionId,
      configId: option.id,
      value: model,
    })
    if (Array.isArray(result?.configOptions)) catalog.configOptions = result.configOptions
    else option.currentValue = model
  } else {
    await send('session/set_model', { sessionId, modelId: model })
    if (catalog.models) catalog.models.currentModelId = model
  }
}

export async function setEffort(send: Send, sessionId: string, catalog: Catalog, effort: string) {
  const option = select(catalog, 'thought_level')
  if (!option || !choices(option).some((choice) => choice.value === effort))
    throw new ProtocolError(-32602, `ACP agent 没有强度 ${effort}`)
  const result = await send('session/set_config_option', {
    sessionId,
    configId: option.id,
    value: effort,
  })
  if (Array.isArray(result?.configOptions)) catalog.configOptions = result.configOptions
  else option.currentValue = effort
}

export async function setMode(send: Send, sessionId: string, catalog: Catalog, mode: string) {
  const option = select(catalog, 'mode')
  if (option) {
    const result = await send('session/set_config_option', {
      sessionId,
      configId: option.id,
      value: mode,
    })
    if (Array.isArray(result?.configOptions)) catalog.configOptions = result.configOptions
    else option.currentValue = mode
  } else {
    await send('session/set_mode', { sessionId, modeId: mode })
    if (catalog.modes) catalog.modes.currentModeId = mode
  }
}
