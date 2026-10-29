// 工具形状和可重拼的规则：参数放在规则末尾的 JSON 注释中，避免从自然语言反解范围和派活设置。

import type { ClientToolNamespaceSpec } from '../../protocol/src/client-tools.mjs'
import {
  MANAGER_TOOLS,
  managerLineRules,
  managerRoleRules,
  managerSessionRules,
} from '../../protocol/src/client-tools-manager.mjs'
import { SESSION_TOOL, sessionTools } from '../../protocol/src/client-tools-sessions.mjs'
import type { Manager } from '../../protocol/src/manager.mjs'

type RuleSettings = Pick<Manager, 'name' | 'scope' | 'rules' | 'dispatch'>
const MARK = '\n<!-- litch-manager-settings: '
export function ruleSettings(recorded: string): RuleSettings | null {
  const at = recorded.lastIndexOf(MARK)
  if (at < 0) return null
  try {
    return JSON.parse(recorded.slice(at + MARK.length, -4)) as RuleSettings
  } catch {
    return null
  }
}
function tagged(text: string, settings: RuleSettings): string {
  return `${text}${MARK}${JSON.stringify(settings)} -->`
}
export function managerTools(manager: RuleSettings): ClientToolNamespaceSpec[] {
  const sessions = sessionTools(false, false)
  return [
    {
      ...sessions,
      description:
        'Delegate in-scope work to lines, follow their reports, send guidance and manage sessions. Manager creation authorizes in-scope delegation, including event turns. Put user decisions on the board.',
      instructions: tagged(managerSessionRules(manager.dispatch.maxRunningLines), manager),
      tools: sessions.tools
        .filter((tool) => tool.name !== SESSION_TOOL.wrapUp)
        .map((tool) =>
          tool.name === SESSION_TOOL.start
            ? {
                ...tool,
                description:
                  'Start an in-scope line with initiation user_asked, including on manager event turns. Supply a self-contained brief. Out-of-scope work requires a board decision first. Permissions and the running-line limit are enforced by the device.',
              }
            : tool.name === SESSION_TOOL.archive
              ? {
                  ...tool,
                  description:
                    'Archive a session after the user explicitly agrees to archive that session on the board or in chat. For a finished line with changes landed or discarded, ask through a board decision. Conversations remain in Archived and can be restored with unarchive. Clean Litch worktrees are removed; branches and uncommitted changes are kept. Stopped sub-sessions are archived with it; working or pinned sessions are not archived. Pass "self" to archive this session when the turn ends.',
                }
              : tool,
        ),
    },
    { ...MANAGER_TOOLS, instructions: managerInstructions(manager) },
  ]
}
export function managerInstructions(manager: RuleSettings): string {
  return tagged(
    [managerRoleRules(manager.scope), manager.rules].filter(Boolean).join('\n\n'),
    manager,
  )
}
export function lineInstructions(manager: RuleSettings): string {
  return tagged(managerLineRules(manager.name, manager.dispatch), manager)
}
export function refreshManagerRules(name: string, recorded: string): string | null {
  const settings = ruleSettings(recorded)
  if (!settings) return null
  if (name === MANAGER_TOOLS.name) return managerInstructions(settings)
  if (name === 'litch_sessions') {
    if (recorded.startsWith('Manager sessions'))
      return tagged(managerSessionRules(settings.dispatch.maxRunningLines), settings)
    // 子会话保留自己的普通会话规则，第七层单独重拼。
    const marker = '\n\nYou are a line started by manager '
    const at = recorded.indexOf(marker)
    if (at >= 0) return `${recorded.slice(0, at)}\n\n${lineInstructions(settings)}`
  }
  return null
}
