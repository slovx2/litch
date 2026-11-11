// 模型等级排序页和越级提示的预览场景：桌面夹具（model-ranking-fixture.tsx）和手机预览共用。
// 模型名是公开型号，设备、会话都是虚构的；只用于预览截图和验收，不进正式包。
import type { ModelLimitFailureView, ModelRankingSnapshot } from '@litch/core'

type RankedModel = ModelRankingSnapshot['models'][number]
export type RankingScene = 'off' | 'on' | 'unranked' | 'partial'

const model = (harness: string, id: string, name: string, available = true): RankedModel => ({
  key: JSON.stringify([harness, '', id]),
  harness,
  model: id,
  name,
  available,
})
const haiku = model('claude-code', 'claude-haiku-5-5', 'Haiku 5.5')
const sonnet = model('claude-code', 'claude-sonnet-5-5', 'Sonnet 5.5')
const opus = model('claude-code', 'claude-opus-5-5', 'Opus 5.5')
const fable51 = model('claude-code', 'claude-fable-5-1', 'Fable 5.1')
const fable52 = model('claude-code', 'claude-fable-5-2', 'Fable 5.2')
const luna = model('codex', 'gpt-6-luna', 'GPT-6-Luna')
const sol = model('codex', 'gpt-6-sol', 'GPT-6-Sol')
const sol61 = model('codex', 'gpt-6.1-sol', 'GPT-6.1-Sol')
const astra = model('codex', 'gpt-6-astra', 'GPT-6-Astra')
const terra = model('codex', 'gpt-6-terra', 'GPT-6-Terra')
const pi = model('pi', 'example-lab/fast-1', 'fast-1', false)
const key = (entry: RankedModel) => entry.key

const base: ModelRankingSnapshot = {
  schemaVersion: 1,
  revision: 4,
  mode: 'builtin',
  crossHarness: false,
  builtinRevision: '2026-11-11.1',
  errors: {},
  // 内置预排：Claude 和 Codex 同档的模型落在同一个全局等级里，关着开关时各自成阶梯
  tiers: [
    [haiku, luna],
    [sonnet, sol, sol61],
    [opus, astra],
    [fable51, fable52],
  ].map((tier) => tier.map(key)),
  unranked: [],
  models: [haiku, sonnet, opus, fable51, fable52, luna, sol, sol61, astra],
}

export function rankingScene(scene: RankingScene): ModelRankingSnapshot {
  switch (scene) {
    case 'off':
      return base
    case 'on':
      // 用户把 Astra 排到了 Opus 之上、和 Fable 并级
      return {
        ...base,
        mode: 'custom',
        crossHarness: true,
        tiers: [[haiku, luna], [sonnet, sol, sol61], [opus], [astra, fable51, fable52]].map(
          (tier) => tier.map(key),
        ),
        manual: [astra.key],
      }
    case 'unranked':
      return {
        ...base,
        unranked: [terra, pi].map(key),
        models: [...base.models, terra, pi],
      }
    case 'partial':
      return {
        ...base,
        errors: {
          gemini: 'spawn gemini ENOENT',
          qwen: 'harness disabled',
          acp: 'Authentication required',
        },
      }
  }
}

/** 预览里设备声明的 harness：Gemini 没装、Qwen 停用、ACP 可用但读不到（多半没登录） */
export const SCENE_HARNESSES = [
  { id: 'claude-code', name: 'Claude Code', badge: 'CC', state: 'ready', down: null },
  { id: 'codex', name: 'Codex', badge: 'CX', state: 'ready', down: null },
  { id: 'pi', name: 'Pi', badge: 'PI', state: 'ready', down: null },
  { id: 'gemini', name: 'Gemini', badge: 'GE', state: 'unavailable', down: 'notInstalled' },
  { id: 'qwen', name: 'Qwen', badge: 'QW', state: 'disabled', down: null },
  { id: 'acp', name: 'ACP', badge: 'AC', state: 'ready', down: null },
] as const

/** 建议卡上越级的那个错误：经理用 Opus，提案要 Fable */
export function limitScene(kind: 'exceeded' | 'unranked'): ModelLimitFailureView {
  const child = kind === 'exceeded' ? fable52 : terra
  const parent = kind === 'exceeded' ? opus : sol61
  return {
    reason: {
      litch: kind === 'exceeded' ? 'model_cap_exceeded' : 'model_rank_unknown',
      kind,
      parent,
      child,
      allowed: kind === 'exceeded' ? [opus, sonnet, haiku] : [sol61, sol, luna],
      allowedModels: [],
      parentModel: parent.model,
      requestedModel: child.model,
      mode: 'builtin',
      crossHarness: false,
      revision: 4,
    },
    text: {
      key: kind === 'exceeded' ? 'modelRanking.limitExceeded' : 'modelRanking.limitUnranked',
      args: { parent: parent.name, child: child.name },
    },
    settings: [
      { kind: 'manager-default-model', deviceId: 'local', sessionId: 'manager-thread' },
      { kind: 'model-ranking', deviceId: 'local' },
    ],
  }
}
