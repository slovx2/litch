import type { OfficeError } from './archive.ts'
export type FrameResult = 'ready' | { ok: true } | { ok: false; error: OfficeError }
const codes: readonly OfficeError[] = ['invalid', 'budget', 'active', 'timeout']
/** MessagePort 仍是输入边界；只接受确定形状和白名单错误，不能把任意值当翻译键。 */
export function frameResult(value: unknown): FrameResult {
  if (value === 'ready') return 'ready'
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const item = value as Record<string, unknown>
    if (item.ok === true && item.isolated === true) return { ok: true }
    if (item.ok === false && codes.some((code) => code === item.error))
      return { ok: false, error: item.error as OfficeError }
  }
  return { ok: false, error: 'invalid' }
}
