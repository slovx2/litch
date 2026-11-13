// 工具形状和可重拼的规则：参数放在规则末尾的 JSON 注释中，避免从自然语言反解范围和派活设置。

import { createHash } from 'node:crypto'
import type { ClientToolNamespaceSpec } from '../../protocol/src/client-tools.mjs'
import {
  MANAGER_ITEM_NOTE,
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
export function managerBundle(manager: RuleSettings, native: boolean, taskCards = true) {
  return [...managerTools(manager, taskCards), ...(native ? [] : [PRESENTATION_SPEC])]
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
  '你接手了这个经理的工作。先用 litch_manager 读取最新看板，再读取相关工作线的 pending requests/questions。索引是时间点参考，旧经理摘要可能过时；本次接班不新增授权、不代用户批准待答项，也不把摘要建议当成用户决定。目标 harness 加载自己的项目指令和技能，旧 harness 的配置与记忆不会自动迁移。You are taking over this manager. Read the latest board and relevant workline requests/questions first. The index is a snapshot and the previous manager summary may be stale. Handover grants no new authorization; do not approve user-only requests or treat recommendations as user decisions. The target loads its own project instructions and skills; previous harness configuration and memory are not transferred.'
export const MANAGER_SUMMARY_PROMPT =
  '用户正在重置经理会话。请只写交接摘要：在做的事、待验收的工作线、等用户答复的事、下一步。不要调用改变状态的工具。The user is resetting this manager session. Write only a handover summary: ongoing work, lines awaiting acceptance, pending user decisions, and next steps. Do not call tools that change state.'

/** 约 2000 token 的结构化目录；所有类别保留总数、未展开数量和读取入口，不拼对象正文。 */
export function managerHandoverIndex(
  identity: Record<string, unknown>,
  categories: Record<string, { entries: Record<string, unknown>[]; read: string; total?: number }>,
): string {
  const sections = Object.fromEntries(
    Object.entries(categories).map(([key, value]) => [
      key,
      {
        total: value.total ?? value.entries.length,
        omitted: (value.total ?? value.entries.length) - Math.min(value.entries.length, 8),
        read: value.read,
        entries: value.entries.slice(0, 8),
      },
    ]),
  )
  const value = { ...identity, sections }
  const cost = (text: string) =>
    Array.from(text).reduce((sum, char) => sum + (char.charCodeAt(0) > 127 ? 1 : 0.25), 0)
  while (cost(JSON.stringify(value)) > 2000) {
    const section = Object.values(sections)
      .filter((one) => one.entries.length)
      .sort((a, b) => JSON.stringify(b.entries).length - JSON.stringify(a.entries).length)[0]
    if (!section) break
    section.entries.pop()
    section.omitted++
  }
  return JSON.stringify(value)
}
export function managerTools(manager: RuleSettings, taskCards = true): ClientToolNamespaceSpec[] {
  const sessions = sessionTools(false, taskCards)
  return [
    {
      ...sessions,
      description:
        'Delegate user-requested or approved in-scope work to lines, including event turns. Follow reports, send guidance and manage sessions. Scope alone does not authorize self-discovered work. Put user decisions on the board.',
      instructions: tagged(
        managerSessionRules(manager.dispatch.maxRunningLines, taskCards),
        manager,
      ),
      tools: sessions.tools
        .filter((tool) => tool.name !== SESSION_TOOL.wrapUp)
        .map((tool) =>
          tool.name === SESSION_TOOL.start
            ? {
                ...tool,
                description:
                  'Start user-requested or approved in-scope work with initiation user_asked, including on manager event turns. ' +
                  (taskCards
                    ? 'For self-discovered work the user has not requested or approved, use initiation propose with a complete brief; the card starts only after the user clicks Start. Do not leave it only as a backlog item; close any corresponding open item as deferred and reference the card in the reason. Do not use cards for already-authorized work. '
                    : 'Task cards are disabled. Record self-discovered work in board decisions or items; obtain required user approval through a board decision before starting. ') +
                  `Supply a self-contained brief. Out-of-scope work requires a board decision first. Permissions and the running-line limit are enforced by the device. ${MANAGER_ITEM_NOTE}`,
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
export function lineInstructions(manager: RuleSettings, taskCards = true): string {
  return tagged(managerLineRules(manager.name, manager.dispatch, taskCards), manager)
}
export function refreshManagerRules(
  name: string,
  recorded: string,
  taskCards = true,
): string | null {
  const settings = ruleSettings(recorded)
  if (!settings) return null
  if (name === MANAGER_TOOLS.name) return managerInstructions(settings)
  if (name === 'litch_sessions') {
    if (recorded.startsWith('Manager sessions'))
      return tagged(managerSessionRules(settings.dispatch.maxRunningLines, taskCards), settings)
    // 子会话保留自己的普通会话规则，第七层单独重拼。
    const marker = '\n\nYou are a line started by manager '
    const at = recorded.indexOf(marker)
    if (at >= 0) return `${recorded.slice(0, at)}\n\n${lineInstructions(settings, taskCards)}`
  }
  return null
}
