import {
  AUTOMATION_GUIDE_NAMESPACE,
  automationGuide,
} from '../../protocol/src/automation-skills.mjs'
import { clientToolFailure } from '../../protocol/src/client-tools.mjs'
import type { DeviceToolRegistry } from './device-tools.mjs'
import { isObject } from './wire.mjs'

export const DEVICE_CHROME_GUIDE =
  'For Chrome on a Linux session device, targets() marks it as sessionDevice alongside the controller when available. Localhost belongs to the machine named by the target. Use explicit IDs from this turn. A batch can use only one execution end. Approval, sign-in and files are handled on the machine that runs the selected Chrome. A refusal or disconnect never redirects the tool to the other browser.'

const LOCAL_ACCESS_GUIDE =
  'An unattended browser call can submit a non-blocking card for site access. Wait for the result in this conversation, then retry only if it says you may. If some steps already ran, inspect the current state before continuing. Do not retry a pending request or use another route to bypass a restriction. Using Computer Use on Litch itself requires the user to be present. Login and disabled features require the user.'

export function registerAutomationGuide(
  tools: DeviceToolRegistry,
  deviceChrome: () => boolean = () => false,
): void {
  tools.register(AUTOMATION_GUIDE_NAMESPACE, async (call) => {
    const topic = isObject(call.arguments) ? call.arguments.topic : null
    if (call.tool !== 'guide' || (topic !== 'browser' && topic !== 'computer'))
      return clientToolFailure('invalid', 'guide 的 topic 必须是 browser 或 computer。')
    return {
      success: true,
      contentItems: [
        {
          type: 'inputText',
          text:
            `${automationGuide(topic)}\n\n${LOCAL_ACCESS_GUIDE}` +
            (topic === 'browser' && deviceChrome() ? `\n\n${DEVICE_CHROME_GUIDE}` : ''),
        },
      ],
    }
  })
}
