import { FILE_LINK_SPEC } from '../../protocol/src/file-link-instructions.mjs'
// 工具形状和可重拼的规则：参数放在规则末尾的 JSON 注释中，避免从自然语言反解范围和派活设置。

import { createHash } from 'node:crypto'
import type { ClientToolNamespaceSpec } from '../../protocol/src/client-tools.mjs'
import {
  MANAGER_TOOLS,
  managerLineRules,
  managerRoleRules,
  managerSessionRules,
  managerSettingsRules,
} from '../../protocol/src/client-tools-manager.mjs'
import { PRESENTATION_SPEC } from '../../protocol/src/client-tools-presentation.mjs'
import { REPOSITORY_TOOLS } from '../../protocol/src/client-tools-repository.mjs'
import { SESSION_TOOL, sessionTools } from '../../protocol/src/client-tools-sessions.mjs'
import type { Manager } from '../../protocol/src/manager.mjs'

type RuleSettings = Pick<Manager, 'name' | 'scope' | 'rules' | 'dispatch' | 'contact'>
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
  const { name, scope, rules, dispatch, contact } = settings
  return `${text}${MARK}${JSON.stringify({ name, scope, rules, dispatch, contact })} -->`
}
/** 创建、检测和重置共用一份生成器，不把线程号和运行计数混进能力版本。 */
export function managerBundle(manager: RuleSettings, native: boolean) {
  return [...managerTools(manager), ...(native ? [FILE_LINK_SPEC] : [PRESENTATION_SPEC])]
}
export function managerFingerprint(tools: unknown): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : value
  return createHash('sha256')
    .update(JSON.stringify(canonical(tools)))
    .digest('hex')
}
export const MANAGER_HANDOVER_PROMPT =
  '你接手了这个经理的工作。先用 litch_manager 读取看板，了解当前情况，再根据交接摘要继续。You are taking over this manager. Read the board with litch_manager first, then continue using the handover summary below.'
export const MANAGER_SUMMARY_PROMPT =
  '用户正在重置经理会话。请只写交接摘要：在做的事、待验收的工作线、等用户答复的事、下一步。不要调用改变状态的工具。The user is resetting this manager session. Write only a handover summary: ongoing work, lines awaiting acceptance, pending user decisions, and next steps. Do not call tools that change state.'
export function managerTools(manager: RuleSettings): ClientToolNamespaceSpec[] {
  const sessions = sessionTools(false)
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
                  'Start an in-scope line with initiation user_asked, including on manager event turns. Use initiation propose with a complete brief for a suggestion card that starts only after the user clicks Start. Do not use cards for already-authorized work. Supply a self-contained brief. Out-of-scope work requires a board decision first. Permissions and the running-line limit are enforced by the device.',
              }
            : tool.name === SESSION_TOOL.archive
              ? {
                  ...tool,
                  description:
                    'Archive your finished lines whose changes are landed or discarded without asking the user, including on event turns. Other sessions require explicit user agreement on the board or in chat. Conversations remain in Archived and can be restored with unarchive. Clean Litch worktrees are removed; branches and uncommitted changes are kept. Stopped sub-sessions are archived with it; working or pinned sessions are not archived. Pass "self" to archive this session when the turn ends; self still requires user agreement.',
                }
              : tool,
        ),
    },
    { ...MANAGER_TOOLS, instructions: managerInstructions(manager) },
    REPOSITORY_TOOLS,
  ]
}
export function managerInstructions(manager: RuleSettings): string {
  return tagged(
    [
      managerRoleRules(manager.scope),
      managerSettingsRules(manager.dispatch, manager.contact),
      manager.rules,
    ]
      .filter(Boolean)
      .join('\n\n'),
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
