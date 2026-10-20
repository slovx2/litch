// 模型清单这一块不靠浏览器就能测的（packages/ui/test/hconfig-models.test.mjs 直接引这个文件）：
// 上下文窗口怎么写短、怎么从输入框里读出来，一项是“原样用”还是“以谁为底稿”、实际显示成什么，
// 开始自定义时把自带目录导成清单、上下移动、表单校验、清单改没改过。只用可擦除的语法，只类型引用核心。
import type { HcModelBase, HcModelEntry } from '@litch/core'

/** 上下文窗口写短：200000 → 200K，1000000 → 1M，1047576 → 1.05M，不整的 K 留一位小数 */
export function shortWindow(count: number): string {
  if (count >= 1_000_000) return `${trim((count / 1_000_000).toFixed(2))}M`
  if (count >= 1000) return `${trim((count / 1000).toFixed(1))}K`
  return String(count)
}

const trim = (text: string) => text.replace(/\.?0+$/, '')

/** 读输入框里的上下文窗口：整数（可以带逗号、空格、下划线分组），也认 200K、1M、1.5M 这种写法。空的是“照底稿” */
export type WindowParsed = { ok: true; value: number | null } | { ok: false }

export function parseWindow(text: string): WindowParsed {
  const raw = text.trim().replace(/[,_\s]/g, '')
  if (raw === '') return { ok: true, value: null }
  const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(raw)
  if (!match) return { ok: false }
  const unit = (match[2] ?? '').toLowerCase()
  const scale = unit === 'k' ? 1000 : unit === 'm' ? 1_000_000 : 1
  const value = Math.round(Number(match[1]) * scale)
  if (!Number.isSafeInteger(value) || value <= 0) return { ok: false }
  // 不带单位的必须是整数
  if (scale === 1 && match[1]?.includes('.')) return { ok: false }
  return { ok: true, value }
}

/** 原样用底稿里的那个模型：模型名就是底稿的、显示名和上下文都没改 */
export const asIs = (entry: HcModelEntry): boolean =>
  entry.id === entry.base && entry.displayName === null && entry.contextWindow === null

/** 一项实际是什么样：显示名、上下文照底稿补上；底稿不在自带目录里了 missing 为真 */
export function resolved(
  entry: HcModelEntry,
  bases: readonly HcModelBase[],
): { name: string; window: number | null; base: HcModelBase | null } {
  const base = bases.find((one) => one.id === entry.base) ?? null
  return {
    name: entry.displayName ?? base?.displayName ?? entry.id,
    window: entry.contextWindow ?? base?.contextWindow ?? null,
    base,
  }
}

/** 开始自定义：自带目录整份导成“原样用”的项，顺序不变 */
export const importAll = (bases: readonly HcModelBase[]): HcModelEntry[] =>
  bases.map((base) => ({ id: base.id, displayName: null, contextWindow: null, base: base.id }))

/** 把第 index 项挪一格（-1 往上、1 往下）；挪不动原样返回 */
export function moved<T>(list: readonly T[], index: number, step: -1 | 1): T[] {
  const to = index + step
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list]
  const next = [...list]
  const [item] = next.splice(index, 1)
  next.splice(to, 0, item as T)
  return next
}

/** 两份清单一样（顺序也算） */
export const sameEntries = (a: readonly HcModelEntry[], b: readonly HcModelEntry[]): boolean =>
  a.length === b.length &&
  a.every((one, at) => {
    const other = b[at]
    return (
      other !== undefined &&
      one.id === other.id &&
      one.base === other.base &&
      one.displayName === other.displayName &&
      one.contextWindow === other.contextWindow
    )
  })

/** 新增、改一项时表单里的东西。mode：same 原样用底稿，custom 以底稿为底换名字、显示名、上下文 */
export interface ModelForm {
  base: string
  mode: 'same' | 'custom'
  id: string
  displayName: string
  contextWindow: string
}

/**
 * 表单从哪儿开始。改一项：照那一项；新增：底稿默认挑头一个还不在清单里的（taken）原样用，
 * 自带目录都已经在清单里了就挑头一个、改成以它为底稿自定义
 */
export function formOfEntry(
  entry: HcModelEntry | null,
  bases: readonly HcModelBase[],
  taken: ReadonlySet<string> = new Set(),
): ModelForm {
  if (!entry) {
    const free = bases.find((one) => !taken.has(one.id))
    return {
      base: (free ?? bases[0])?.id ?? '',
      mode: free ? 'same' : 'custom',
      id: free ? '' : (bases[0]?.id ?? ''),
      displayName: '',
      contextWindow: '',
    }
  }
  return {
    base: entry.base,
    mode: asIs(entry) ? 'same' : 'custom',
    id: entry.id,
    displayName: entry.displayName ?? '',
    contextWindow: entry.contextWindow === null ? '' : String(entry.contextWindow),
  }
}

export type ModelProblem =
  | 'hc.models.bad.base'
  | 'hc.models.bad.id'
  | 'hc.models.bad.taken'
  | 'hc.models.bad.window'

/** 表单 → 一项。taken 是清单里别的项（不含正在改的这一项）已经用了的模型名 */
export function entryOfForm(
  form: ModelForm,
  bases: readonly HcModelBase[],
  taken: ReadonlySet<string>,
): { ok: true; entry: HcModelEntry } | { ok: false; problem: ModelProblem; field: string } {
  if (!bases.some((one) => one.id === form.base)) {
    return { ok: false, problem: 'hc.models.bad.base', field: 'base' }
  }
  if (form.mode === 'same') {
    if (taken.has(form.base)) return { ok: false, problem: 'hc.models.bad.taken', field: 'base' }
    return {
      ok: true,
      entry: { id: form.base, displayName: null, contextWindow: null, base: form.base },
    }
  }
  const id = form.id.trim()
  if (id === '') return { ok: false, problem: 'hc.models.bad.id', field: 'id' }
  if (taken.has(id)) return { ok: false, problem: 'hc.models.bad.taken', field: 'id' }
  const window = parseWindow(form.contextWindow)
  if (!window.ok) return { ok: false, problem: 'hc.models.bad.window', field: 'contextWindow' }
  return {
    ok: true,
    entry: {
      id,
      displayName: form.displayName.trim() || null,
      contextWindow: window.value,
      base: form.base,
    },
  }
}

/** 按名字、模型名筛底稿（不分大小写） */
export function filterBases(bases: readonly HcModelBase[], query: string): HcModelBase[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...bases]
  return bases.filter((base) => {
    const hay = `${base.id} ${base.displayName}`.toLowerCase()
    return words.every((word) => hay.includes(word))
  })
}
