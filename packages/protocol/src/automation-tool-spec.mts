// 由 scripts/generate-automation-contracts.mjs 生成；请修改 automation-contracts/src/tool-spec.mts。
/** 工具定义的数据合同；不绑定某个模型 SDK 或传输。 */
export interface ClientToolFunctionSpec {
  type: 'function'
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ClientToolNamespaceSpec {
  type: 'namespace'
  name: string
  description: string
  tools: ClientToolFunctionSpec[]
  /** 宿主追加到系统/开发者指令；不覆盖用户自己的指令。 */
  instructions?: string
}
