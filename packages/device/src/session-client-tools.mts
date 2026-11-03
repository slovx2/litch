import { CLIENT_TOOL_NAMESPACE } from '../../protocol/src/client-tools.mjs'
import { sessionClientTools } from '../../protocol/src/client-tools-session.mjs'
import {
  deviceMachineEnabled,
  deviceToolSwitches,
} from '../../protocol/src/client-tools-settings.mjs'
import { clientToolSpecs } from '../../protocol/src/client-tools-specs.mjs'
import { TASKS_TOOLS } from '../../protocol/src/client-tools-tasks.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import { isObject } from './wire.mjs'

/** 设备所有新会话入口最后统一整理一次；不给不支持 clientTools 的引擎增加参数。 */
export function prepareSessionTools(
  params: Record<string, unknown>,
  harness: string,
  runtime: Record<string, unknown> | null,
  native: boolean,
  values: Record<string, unknown> | undefined,
  options: { tasks: boolean; desktopNamespaces?: readonly string[] },
): Record<string, unknown> {
  if (params.ephemeral === true) return params
  if (!Array.isArray(runtime?.extensions) || !runtime.extensions.includes(EXTENSION.clientTools))
    return params
  const given = Array.isArray(params.dynamicTools) ? params.dynamicTools : []
  const names = new Set(given.filter(isObject).map((spec) => spec.name))
  const tools = [
    ...given,
    ...clientToolSpecs(
      (options.desktopNamespaces ?? []).filter(
        (name) =>
          names.has(CLIENT_TOOL_NAMESPACE.manager) &&
          name === CLIENT_TOOL_NAMESPACE.echo &&
          !names.has(name),
      ),
    ),
    ...(options.tasks &&
    names.has(CLIENT_TOOL_NAMESPACE.manager) &&
    !names.has(CLIENT_TOOL_NAMESPACE.tasks)
      ? [TASKS_TOOLS]
      : []),
  ]
  const dynamicTools = sessionClientTools(
    tools,
    native ? 'codex' : harness,
    deviceToolSwitches(values, harness),
    null,
    deviceMachineEnabled(values),
  )
  const { dynamicTools: _given, ...rest } = params
  return dynamicTools.length ? { ...rest, dynamicTools } : rest
}
