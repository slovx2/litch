import { CLIENT_TOOL_NAMESPACE } from './client-tools.mjs'
import { portableComputerTools } from './client-tools-computer-portable.mjs'
import { presentationSpec } from './client-tools-presentation.mjs'
import type { ToolSwitches } from './client-tools-settings.mjs'
import { type ClientToolSpecContext, clientToolSpecs } from './client-tools-specs.mjs'

/** 普通会话、经理、子会话及定时新会话共用；执行端能力不参与常驻工具的注入。 */
export function sessionClientTools(
  given: readonly unknown[],
  harness: string | null,
  switches: ToolSwitches,
  context: ClientToolSpecContext | null = null,
  machineEnabled = false,
): unknown[] {
  const switched = new Set<string>([
    CLIENT_TOOL_NAMESPACE.browser,
    CLIENT_TOOL_NAMESPACE.computer,
    'litch_presentation',
  ])
  const seen = new Set<string>()
  switched.add(CLIENT_TOOL_NAMESPACE.machine)
  const kept = given.filter((spec) => {
    if (!spec || typeof spec !== 'object' || !('name' in spec) || typeof spec.name !== 'string')
      return true
    if (switched.has(spec.name) || seen.has(spec.name)) return false
    seen.add(spec.name)
    return true
  })
  const presentation = presentationSpec(harness)
  return [
    ...kept,
    ...(machineEnabled === true ? clientToolSpecs([CLIENT_TOOL_NAMESPACE.machine], context) : []),
    ...clientToolSpecs(
      [
        ...(switches.browser ? [CLIENT_TOOL_NAMESPACE.browser] : []),
        ...(switches.computer && context?.desktopPlatform ? [CLIENT_TOOL_NAMESPACE.computer] : []),
      ],
      context,
    ),
    ...(switches.computer && !context?.desktopPlatform ? [portableComputerTools()] : []),
    ...(presentation ? [presentation] : []),
  ]
}
