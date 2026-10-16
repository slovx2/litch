import type { ThreadItem } from './types.mjs'

export type DynamicToolResult = {
  success: boolean
  contentItems: NonNullable<Extract<ThreadItem, { type: 'dynamicToolCall' }>['contentItems']>
}

export function dynamicToolResult(value: unknown): DynamicToolResult {
  const result = value as Partial<DynamicToolResult> | null
  if (!result || typeof result.success !== 'boolean' || !Array.isArray(result.contentItems))
    throw new Error('工具返回格式无效')
  for (const item of result.contentItems) {
    if (item?.type === 'inputText' && typeof item.text === 'string') continue
    if (item?.type === 'inputImage' && typeof item.imageUrl === 'string') continue
    throw new Error('工具结果内容格式无效')
  }
  return { success: result.success, contentItems: result.contentItems }
}
