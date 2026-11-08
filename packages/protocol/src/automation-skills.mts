// 由 scripts/generate-automation-contracts.mjs 生成；请修改 automation-contracts/src/litch/automation-skills.mts。

import { AUTOMATION_SKILL_FILES, AUTOMATION_SKILL_TOOLS } from './automation-skill-files.mjs'
import type { ClientToolNamespaceSpec } from './automation-tool-spec.mjs'

export const AUTOMATION_GUIDE_NAMESPACE = 'litch_automation'
export const AUTOMATION_GUIDE: ClientToolNamespaceSpec = {
  type: 'namespace',
  name: AUTOMATION_GUIDE_NAMESPACE,
  description: 'Read the usage guide for Litch browser or Computer Use tools.',
  tools: [
    {
      type: 'function',
      name: 'guide',
      description:
        'Read the complete usage instructions before using the corresponding automation tools.',
      inputSchema: {
        type: 'object',
        properties: { topic: { type: 'string', enum: ['browser', 'computer'] } },
        required: ['topic'],
        additionalProperties: false,
      },
    },
  ],
}

/** 与技能共用原文；没有摘要、改写或读取状态。 */
export function automationGuide(topic: 'browser' | 'computer'): string {
  const skill = automationSkill(`litch_${topic}`)!
  return Object.values(skill.files)
    .map((text) => text.replace(/^---\n[\s\S]*?\n---\n\n/, ''))
    .join('\n')
}

export interface AutomationSkill {
  name: string
  files: Record<string, string>
}

export function automationSkill(namespace: string): AutomationSkill | null {
  const name =
    namespace === 'litch_browser'
      ? 'litch-browser-automation'
      : namespace === 'litch_computer'
        ? 'litch-computer-automation'
        : null
  if (!name) return null
  const prefix = `${name}/`
  return {
    name,
    files: Object.fromEntries(
      Object.entries(AUTOMATION_SKILL_FILES)
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, text]) => [path.slice(prefix.length), text]),
    ),
  }
}

/** 旧客户端或外部宿主的不同合同继续完整说明；不让新技能教它尚未提供的动作。 */
export function automationSkillMatches(spec: ClientToolNamespaceSpec): boolean {
  const skill = automationSkill(spec.name)
  const names = AUTOMATION_SKILL_TOOLS[spec.name]
  if (
    !skill ||
    !names ||
    names.length !== spec.tools.length ||
    names.some((name) => !spec.tools.some((t) => t.name === name))
  )
    return false
  const text = Object.values(skill.files).join('\n')
  return (
    text.includes(spec.description) &&
    (!spec.instructions || text.includes(spec.instructions)) &&
    spec.tools.every((tool) =>
      tool.description
        .split('\n')
        .every((part) => text.includes(part.replace(/^macOS: |^Windows: /, ''))),
    )
  )
}

// 原句选择，不改写操作约束。其余句子完整保留在技能中；输入/审批相关工具保守保留更多说明。
const BROWSER_SENTENCES: Record<string, number[]> = {
  downloads: [0, 1, 2, 3, 4, 7, 8],
  targets: [0, 5, 6, 7, 8, 10, 11],
  ensure_claimed: [0, 2, 3, 4],
  claim: [0, 1],
  release: [0],
  tabs: [0, 1],
  navigate: [0, 3],
  snapshot: [0, 5, 6],
  click: [0, 2, 3, 4, 5],
  type: [0, 2, 3, 4],
  press: [0, 1, 2],
  scroll: [0],
  screenshot: [0, 1],
  wait: [0, 1],
  console: [0],
  evaluate: [0, 1, 2],
  upload: [0, 1, 3, 4, 5],
  dialog: [0],
  request_sign_in: [0, 1, 4, 7, 8, 9],
  show: [0, 1, 4, 5],
  run_actions: [0, 2, 3, 4, 5, 6, 7, 8],
}
const sentences = (text: string) => text.split(/(?<=[.!?])\s+(?=[A-Z])/)

/** 技能可用时才调用；只缩文字，schema、工具名和执行行为保持原样。 */
export function automationSkillSpec(
  spec: ClientToolNamespaceSpec,
  path: string | null,
): ClientToolNamespaceSpec {
  const skill = automationSkill(spec.name)
  if (!skill) return spec
  const topic = spec.name === 'litch_browser' ? 'browser' : 'computer'
  const hint = path
    ? `Read ${skill.name} skill (${path}) before using these tools. If unavailable, read litch_automation.guide with topic "${topic}".`
    : `Read litch_automation.guide with topic "${topic}" before using these tools.`
  let description = spec.description
  if (spec.name === 'litch_browser') {
    // 总说明中的安全底线逐行保留；仅把重复的入门与批量说明移到 skill。
    const lines = description.split('\n')
    description = [sentences(lines[0] ?? '')[0], ...lines.slice(2)].join('\n')
  } else if (description.includes('Safety rules (always follow):')) {
    description = `${description.split('\n\n')[0]}\nOn explicit Stop/Esc, leave that app alone this turn.\n\n${description.slice(description.indexOf('Safety rules (always follow):'))}`
  } else if (description.includes('\n\nRules:')) {
    description = `${description.split('\n\n')[0]}\nOn explicit Stop/Esc, leave that app alone this turn.\n\n${description.slice(description.indexOf('Rules:'))}`
  }
  // 路径放 instructions，避免长用户名让 namespace 再撞 1024 限制。
  const reminder = path
    ? `Read ${skill.name} skill before use.`
    : `Before use, read litch_automation.guide(topic: "${topic}").`
  return {
    ...spec,
    description: `${description}\n${reminder}`,
    instructions: hint,
    tools: spec.tools.map((tool) => {
      let text = tool.description
      if (spec.name === 'litch_browser') {
        const selected = BROWSER_SENTENCES[tool.name]
        if (selected)
          text = sentences(text)
            .filter((_, index) => selected.includes(index))
            .join(' ')
      } else if (tool.name === 'get_app_state') {
        // portable 描述包含两平台时分别选句，不能把 Windows 句子丢掉。
        text = text
          .split('\n')
          .map((part) =>
            sentences(part)
              .filter(
                (sentence, index) =>
                  index === 0 ||
                  /BEFORE|before acting|resized|conflict|Allow|business result/.test(sentence),
              )
              .join(' '),
          )
          .join('\n')
      } else if (tool.name !== 'run_actions') {
        text = sentences(text)
          .filter((sentence) => !sentence.startsWith('Prefer run_actions'))
          .join(' ')
      }
      return { ...tool, description: `${text} ${reminder}` }
    }),
  }
}
