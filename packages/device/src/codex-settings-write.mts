// 原生 codex 的配置项怎么写（litch/harness/config/write、config/action）。
// 先按当下读到的结构把每一项核对一遍（有没有这一项、锁没锁、值合不合规矩），一项不对整批都不写；
// 再一次 config/batchWrite 写完 config.toml 里的键（带版本，codex 那头要么全写要么全不写）。
// 技能的开关不走 batchWrite：codex 要经 skills/config/write 改才会清掉它的技能缓存（上游 catalog_processor.rs），
// 它们排在 batchWrite 之后一个一个写——batchWrite 被拒的话一个都不会写。自动起名的开关存在设备进程里（codex-titles.mts），
// 也排在 batchWrite 之后。
import type {
  HarnessConfigEdit,
  HarnessConfigWriteResponse,
  HarnessSettingSpec,
} from '../../protocol/src/harness-config.mjs'
import {
  type Ask,
  batchWrite,
  type CodexEdit,
  overridingLayer,
  readSnapshot,
  splitKey,
} from './codex-config-io.mjs'
import { type CodexSettings, MEMORY_RESET, readCodexSettings } from './codex-settings.mjs'
import { HarnessConfigError, type TranslatorContext, text } from './harness-config.mjs'
import { isObject } from './wire.mjs'

type Spec = CodexSettings['specs'][number]

function invalid(harness: string, key: string, zh: string, en: string): HarnessConfigError {
  return new HarnessConfigError('invalidValue', harness, text(zh, en), key)
}

/** 值和这一项的类型对得上；不对抛 invalidValue */
function check(harness: string, spec: HarnessSettingSpec, value: unknown): void {
  if (value === null) {
    if (spec.clearable === false)
      throw invalid(harness, spec.key, `${spec.key} 不能清掉`, `${spec.key} cannot be cleared`)
    return
  }
  const bad = () =>
    invalid(harness, spec.key, `${spec.key} 的值不对`, `Invalid value for ${spec.key}`)
  switch (spec.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw bad()
      return
    case 'enum':
      if (typeof value !== 'string') throw bad()
      if (!spec.allowCustom && !spec.options?.some((item) => item.value === value))
        throw invalid(
          harness,
          spec.key,
          `${spec.key} 只能是这几个之一：${(spec.options ?? []).map((item) => item.value).join('、')}`,
          `${spec.key} must be one of the listed options`,
        )
      if (!value.trim()) throw bad()
      return
    case 'string':
    case 'text':
    case 'path':
      if (typeof value !== 'string') throw bad()
      return
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || (spec.type === 'integer' && !Number.isInteger(value)))
        throw bad()
      if (spec.minimum !== undefined && value < spec.minimum) throw bad()
      if (spec.maximum !== undefined && value > spec.maximum) throw bad()
      return
    default:
      return
  }
}

interface Plan {
  edits: CodexEdit[]
  skills: { path: string; enabled: boolean }[]
  /** 自动起名改成什么（null 是回到默认）；没改是 undefined */
  autoTitle?: boolean | null
  restartRequired: boolean
}

function plan(harness: string, settings: CodexSettings, edits: unknown): Plan {
  if (!Array.isArray(edits) || edits.length === 0)
    throw new HarnessConfigError(
      'invalidValue',
      harness,
      text('edits 要是非空的数组', 'edits must be a non-empty array'),
    )
  const byKey = new Map<string, Spec>(settings.specs.map((spec) => [spec.key, spec]))
  const result: Plan = { edits: [], skills: [], restartRequired: false }
  const seen = new Set<string>()
  for (const edit of edits as HarnessConfigEdit[]) {
    if (!isObject(edit) || typeof edit.key !== 'string')
      throw new HarnessConfigError(
        'invalidValue',
        harness,
        text('每一项要有 key', 'Each edit needs a key'),
      )
    if (seen.has(edit.key))
      throw invalid(harness, edit.key, `${edit.key} 改了两次`, `${edit.key} appears twice`)
    seen.add(edit.key)
    const spec = byKey.get(edit.key)
    if (!spec)
      throw new HarnessConfigError(
        'notFound',
        harness,
        text(`没有这一项：${edit.key}`, `No such setting: ${edit.key}`),
        edit.key,
      )
    if (spec.readOnly)
      throw new HarnessConfigError(
        'readOnly',
        harness,
        spec.readOnlyReason ?? text('这一项是只读的', 'This setting is read only'),
        edit.key,
      )
    const value = edit.value === undefined ? null : edit.value
    check(harness, spec, value)
    if (spec.effect === 'harness') result.restartRequired = true
    if (spec.write?.kind === 'skill') {
      // 清掉就是回到默认（开着）
      result.skills.push({ path: spec.write.path, enabled: value !== false })
      continue
    }
    if (spec.write?.kind === 'autoTitle') {
      result.autoTitle = value as boolean | null
      continue
    }
    if (spec.write?.kind === 'hookTrust') {
      const base = edit.key.slice(0, -'.trusted'.length)
      result.edits.push({
        keyPath: `${base}.trusted_hash`,
        value: value === true ? spec.write.hash : null,
        mergeStrategy: 'replace',
      })
      continue
    }
    result.edits.push({ keyPath: spec.key, value, mergeStrategy: 'replace' })
  }
  return result
}

/** litch/harness/config/write */
export async function writeCodexSettings(
  ask: Ask,
  harness: string,
  home: string | null,
  autoTitle: TranslatorContext['autoTitle'],
  params: Record<string, unknown>,
): Promise<HarnessConfigWriteResponse> {
  if (typeof params.expectedVersion !== 'string')
    throw new HarnessConfigError(
      'invalidValue',
      harness,
      text('缺少 expectedVersion', 'expectedVersion is required'),
    )
  const settings = await readCodexSettings(ask, harness, home, autoTitle.enabled())
  const steps = plan(harness, settings, params.edits)
  await batchWrite(ask, harness, settings.snapshot, steps.edits, params.expectedVersion)
  for (const skill of steps.skills) await ask('skills/config/write', skill)
  if (steps.autoTitle !== undefined) autoTitle.set(steps.autoTitle)
  // 写完重读一遍：新的版本，以及哪些键写进去了但被更高一层盖住
  const after = await readSnapshot(ask, harness)
  const keys = (params.edits as HarnessConfigEdit[]).map((edit) => edit.key)
  const overriddenKeys = keys.filter((key) => {
    const spec = settings.specs.find((item) => item.key === key)
    return !spec?.write && overridingLayer(after, splitKey(key)) !== null
  })
  return { version: after.version, overriddenKeys, restartRequired: steps.restartRequired }
}

/** litch/harness/config/action */
export async function runCodexAction(
  ask: Ask,
  harness: string,
  params: Record<string, unknown>,
): Promise<Record<string, never>> {
  if (params.actionId !== MEMORY_RESET)
    throw new HarnessConfigError(
      'notFound',
      harness,
      text(
        `没有这个动作：${String(params.actionId)}`,
        `No such action: ${String(params.actionId)}`,
      ),
    )
  await ask('memory/reset', {})
  return {}
}
