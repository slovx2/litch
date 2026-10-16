// 校验模型给的参数。形状和 packages/protocol/src/client-tools-browser.mts 里的定义一一对应，改一边要改另一边。
// 不对的回一句给模型看的英文（执行器包成 invalid 失败）。

export class BadArgs extends Error {
  override name = 'BadArgs'
}

export type Args = Record<string, unknown>

/** 参数必须是对象；没给当作空对象 */
export function objectOf(raw: unknown): Args {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new BadArgs('arguments must be an object')
  return raw as Args
}

export function str(args: Args, name: string): string | undefined
export function str(args: Args, name: string, required: true): string
export function str(args: Args, name: string, required = false): string | undefined {
  const value = args[name]
  if (value === undefined || value === null) {
    if (required) throw new BadArgs(`\`${name}\` is required`)
    return undefined
  }
  if (typeof value !== 'string') throw new BadArgs(`\`${name}\` must be a string`)
  return value
}

export function num(args: Args, name: string): number | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadArgs(`\`${name}\` must be a number`)
  }
  return value
}

export function bool(args: Args, name: string): boolean | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new BadArgs(`\`${name}\` must be true or false`)
  return value
}

export function oneOf<T extends string>(
  args: Args,
  name: string,
  options: readonly T[],
  required = false,
): T | undefined {
  const value = str(args, name)
  if (value === undefined) {
    if (required) throw new BadArgs(`\`${name}\` is required (one of ${options.join(', ')})`)
    return undefined
  }
  if (!(options as readonly string[]).includes(value)) {
    throw new BadArgs(`\`${name}\` must be one of ${options.join(', ')}`)
  }
  return value as T
}

export function strings(args: Args, name: string): string[] {
  const value = args[name]
  if (!Array.isArray(value) || value.length === 0 || value.some((one) => typeof one !== 'string')) {
    throw new BadArgs(`\`${name}\` must be a non-empty array of strings`)
  }
  return value as string[]
}

/** 目标：按编号，或者按截图上的坐标。两样都没给时 optional 决定是报错还是回 null */
export type Target = { ref: string } | { x: number; y: number }

export function target(args: Args, optional = false): Target | null {
  const ref = str(args, 'ref')
  if (ref !== undefined) {
    if (!/^e\d+$/.test(ref)) throw new BadArgs('`ref` looks like "e12" (from `snapshot`)')
    return { ref }
  }
  const x = num(args, 'x')
  const y = num(args, 'y')
  if (x !== undefined && y !== undefined) return { x, y }
  if (x !== undefined || y !== undefined) throw new BadArgs('give both `x` and `y`')
  if (optional) return null
  throw new BadArgs('give `ref` (from `snapshot`) or both `x` and `y` (from `screenshot`)')
}

/** 等待的时长：默认、上限 */
export function timeout(args: Args, name: string, fallback: number, most: number): number {
  const value = num(args, name)
  if (value === undefined) return fallback
  return Math.min(Math.max(Math.round(value), 0), most)
}
