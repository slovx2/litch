// 描述和 schema 只取 M2 唯一源；产品呈现由可信宿主显式选择。
import { computerToolsSpec } from '../../automation-contracts/src/litch/client-tools-computer.mjs'
import { portableComputerTools } from '../../automation-contracts/src/litch/client-tools-computer-portable.mjs'
import type { ClientToolNamespaceSpec } from '../../automation-contracts/src/tool-spec.mjs'

export interface ComputerPresentation {
  productName: string
  helperName: string
  namespace: string
}
export interface ComputerToolsOptions extends ComputerPresentation {
  platform: 'darwin' | 'win32' | 'portable'
  batch: boolean
}
export function computerTools(options: ComputerToolsOptions): ClientToolNamespaceSpec {
  const source =
    options.platform === 'portable'
      ? portableComputerTools()
      : computerToolsSpec(options.platform, options.batch)
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string')
      return value
        .replaceAll('Litch Computer Use', options.helperName)
        .replaceAll('Litch', options.productName)
        .replaceAll('litch_computer', options.namespace)
    if (Array.isArray(value)) return value.map(replace)
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)]))
    return value
  }
  const spec = replace(source) as ClientToolNamespaceSpec
  spec.name = options.namespace
  if (!options.batch) spec.tools = spec.tools.filter((tool) => tool.name !== 'run_actions')
  return spec
}
