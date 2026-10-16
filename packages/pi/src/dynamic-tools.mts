import { createHash } from 'node:crypto'
import { ProtocolError, requiredString } from '../../shared/src/protocol-contract.mjs'

export interface ClientTool {
  name: string
  namespace: string | null
  description: string
  inputSchema: Record<string, unknown>
}
export function clientTools(raw: unknown[]): Array<ClientTool & { piName: string }> {
  const tools: ClientTool[] = []
  for (const value of raw) {
    const spec = value as any
    if (spec?.type === 'function') tools.push({ ...spec, namespace: null })
    else if (spec?.type === 'namespace' && Array.isArray(spec.tools)) {
      const namespace = requiredString(spec.name, 'namespace.name')
      for (const tool of spec.tools) {
        if (tool.type !== 'function') throw new ProtocolError(-32602, 'namespace 中必须是 function')
        tools.push({ ...tool, namespace })
      }
    } else throw new ProtocolError(-32602, '动态工具必须是 function 或 namespace')
  }
  const names = new Set<string>()
  return tools.map((tool) => {
    requiredString(tool.name, 'tool.name')
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object')
      throw new ProtocolError(-32602, '动态工具缺少 inputSchema')
    const piName = `client_${createHash('sha256')
      .update(JSON.stringify([tool.namespace, tool.name]))
      .digest('hex')
      .slice(0, 32)}`
    if (names.has(piName)) throw new ProtocolError(-32602, '动态工具名称重复')
    names.add(piName)
    return { ...tool, piName }
  })
}
export function clientToolContent(result: any): any[] {
  if (typeof result?.success !== 'boolean' || !Array.isArray(result.contentItems))
    throw new Error('客户端工具返回值不符合协议')
  const content = result.contentItems.map((item: any) => {
    if (item.type === 'inputText' && typeof item.text === 'string')
      return { type: 'text', text: item.text }
    if (item.type === 'inputImage') {
      const match = /^data:([^;]+);base64,(.+)$/s.exec(item.imageUrl ?? '')
      if (match) return { type: 'image', mimeType: match[1], data: match[2] }
    }
    throw new Error(`不支持客户端工具结果: ${item.type}`)
  })
  if (!result.success)
    throw new Error(
      content
        .filter((item: any) => item.type === 'text')
        .map((item: any) => item.text)
        .join('\n') || '客户端工具执行失败',
    )
  return content
}
