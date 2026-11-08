import {
  AUTOMATION_GUIDE_NAMESPACE,
  automationGuide,
} from '../../protocol/src/automation-skills.mjs'
import { clientToolFailure } from '../../protocol/src/client-tools.mjs'
import type { DeviceToolRegistry } from './device-tools.mjs'
import { isObject } from './wire.mjs'

export function registerAutomationGuide(tools: DeviceToolRegistry): void {
  tools.register(AUTOMATION_GUIDE_NAMESPACE, async (call) => {
    const topic = isObject(call.arguments) ? call.arguments.topic : null
    if (call.tool !== 'guide' || (topic !== 'browser' && topic !== 'computer'))
      return clientToolFailure('invalid', 'guide 的 topic 必须是 browser 或 computer。')
    return { success: true, contentItems: [{ type: 'inputText', text: automationGuide(topic) }] }
  })
}
