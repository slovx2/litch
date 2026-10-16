// 通道上走的都是“值”：纯数据（对象、数组、字符串、数、布尔、null）。
// 值交出去之后就不该再跟着谁变：核心留着自用的那一份、排在通道里等着发的那一份、
// 调用的一方手里的那一份，各是各的。这里是“拷成自己的一份”的那一下。
// 字符串本身不会变，不用拷，所以哪怕条目里带着很长的输出，拷的也只是外面那几层壳。

export function copyValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copyValue) as T
  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) copy[key] = copyValue(entry)
    return copy as T
  }
  return value
}
