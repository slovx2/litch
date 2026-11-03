import { CLIENT_TOOL_NAMESPACE } from '../../protocol/src/client-tools.mjs'
import { sessionClientTools } from '../../protocol/src/client-tools-session.mjs'
import {
  deviceMachineEnabled,
  deviceToolSwitches,
} from '../../protocol/src/client-tools-settings.mjs'
import { clientToolSpecs } from '../../protocol/src/client-tools-specs.mjs'
import { TASKS_TOOLS } from '../../protocol/src/client-tools-tasks.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import { taskCardsSettingKey } from '../../protocol/src/session-tree.mjs'
import { managerTools, ruleSettings } from './manager-rules.mjs'
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
  let given = Array.isArray(params.dynamicTools) ? params.dynamicTools : []
  // 常驻工具与经理角色工具在同一新建入口汇合；按当前任务卡开关重拼角色定义，避免带回旧提卡提示。
  const role = given.find((spec) => isObject(spec) && spec.name === CLIENT_TOOL_NAMESPACE.manager)
  const manager =
    isObject(role) && typeof role.instructions === 'string' ? ruleSettings(role.instructions) : null
  if (manager) {
    const sessions = managerTools(manager, values?.[taskCardsSettingKey(harness)] !== false).find(
      (spec) => spec.name === CLIENT_TOOL_NAMESPACE.sessions,
    )
    if (sessions)
      given = given.map((spec) =>
        isObject(spec) && spec.name === CLIENT_TOOL_NAMESPACE.sessions ? sessions : spec,
      )
  }
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
