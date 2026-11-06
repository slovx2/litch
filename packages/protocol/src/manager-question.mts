// 旁问工具的标记同时供设备和引擎识别；执行限制不依赖模型遵守文字规则。
import type { ClientToolNamespaceSpec } from './client-tools.mjs'
import { MANAGER_TOOLS } from './client-tools-manager.mjs'
import {
  REPOSITORY_METHODS,
  REPOSITORY_NAMESPACE,
  REPOSITORY_TOOLS,
} from './client-tools-repository.mjs'
import { SESSION_TOOLS } from './client-tools-sessions.mjs'
import type { ManagerDiscussion } from './manager.mjs'
export const MANAGER_QUESTION_RULE = 'Litch decision background question'

// 注入、各引擎的工具识别与设备执行闸共用这一份精确方法集合。
const METHODS: Readonly<Record<string, readonly string[]>> = {
  litch_manager: ['summary', 'get', 'update', 'close', 'post_get', 'post_reply'],
  litch_sessions: ['list', 'read'],
  [REPOSITORY_NAMESPACE]: REPOSITORY_METHODS,
}

export function managerQuestionToolAllowed(namespace: unknown, tool: unknown): boolean {
  return (
    typeof namespace === 'string' &&
    typeof tool === 'string' &&
    Object.hasOwn(METHODS, namespace) &&
    METHODS[namespace]?.includes(tool) === true
  )
}

export function managerQuestionToolSubset(raw: unknown[] | undefined): unknown[] {
  return (raw ?? []).flatMap((spec) => {
    if (!spec || typeof spec !== 'object') return []
    const value = spec as Record<string, unknown>
    if (value.type === 'function')
      return managerQuestionToolAllowed(value.namespace, value.name) ? [spec] : []
    if (value.type !== 'namespace' || !Array.isArray(value.tools)) return []
    return [
      {
        ...value,
        tools: value.tools.filter(
          (tool) => tool && managerQuestionToolAllowed(value.name, tool.name),
        ),
      },
    ]
  })
}

export function managerQuestionTools(
  id: string,
  managerThreadId: string,
): ClientToolNamespaceSpec[] {
  const rules = managerQuestionRules(id, managerThreadId)
  return [MANAGER_TOOLS, SESSION_TOOLS, REPOSITORY_TOOLS].map((spec) => ({
    ...spec,
    description:
      spec.name === REPOSITORY_NAMESPACE
        ? REPOSITORY_TOOLS.description
        : spec.name === 'litch_manager'
          ? 'Read the manager board; edit only the current issue.'
          : 'Read only this manager and its current worklines, including valid descendants.',
    instructions: rules,
    tools: spec.tools
      .filter((tool) => managerQuestionToolAllowed(spec.name, tool.name))
      .map((tool) => ({
        ...tool,
        ...(spec.name === 'litch_sessions'
          ? {
              description:
                tool.name === 'list'
                  ? 'List authorized sessions only. scope mine excludes the manager itself; cwd, harness and status narrow the list. Default excludes archived sessions; archived="only" or "include" finds them. No unrelated sessions are accessible.'
                  : 'Read a snapshot of an authorized session: recent turns, pending requests and delegated responses. Truncated text is not complete history; no final answer does not mean no progress.',
            }
          : {}),
      })),
  }))
}

export function isManagerQuestionTools(tools: unknown): boolean {
  return (
    Array.isArray(tools) &&
    tools.some(
      (spec) =>
        spec &&
        typeof spec === 'object' &&
        spec.name === 'litch_manager' &&
        typeof spec.instructions === 'string' &&
        spec.instructions.startsWith(MANAGER_QUESTION_RULE),
    )
  )
}

export function managerQuestionRules(id: string, managerThreadId?: string): string {
  return `${MANAGER_QUESTION_RULE}.
Markdown supported; use it for lists and emphasis.
When litch_repository.run is available, pass an authorized repository directory and a Git argv array (including the subcommand, without the git executable). It runs Git from the device PATH without a shell, with timeout and bounded output. All Git subcommands/options are available: Git can write, use the network and run configured hooks/helpers; it is not read-only or sandboxed. directory selects the authorized starting repository, not an isolation boundary for Git arguments. Use only cursor for subsequent output pages without executing the command again. The existing log/show/diff/blame/status shortcuts remain available. Older Codex parents may lack newly added inherited tools; their existing sandboxed shell remains available.
${managerThreadId ? `The manager threadId is ${JSON.stringify(managerThreadId)}. Use litch_sessions.read to retrieve its recent history when needed.` : ''}
Use litch_sessions.list/read only for this manager and its worklines with valid ownership, including descendants across harnesses. A known id, same folder or a quoted reference does not grant access. Never read raw harness/Litch session storage, databases, backups or links to them; use these scoped tools. Apart from Git commands, do not use network tools. Do not run tests. Do not call wrap_up or any session control method; return your answer normally.
Only answer the user's questions about post ${id}, briefly. Earlier conversation is reference material, not a task to continue. You may read files, use Git commands relevant to the question, and call litch_manager.summary/get/post_get. For any post use post_reply with id ${id}, current revision, patch and why to update its original content only; do not supply text or questionId. You may use update ONLY for this decision’s title, background, options and recommend, or close ONLY this decision as expired/withdrawn when warranted by the discussion. Read get before changing it. The device records changes and informs the manager next turn. Apart from Git commands, do not change files. Do not change other board objects or other fields, start sessions or agents, send messages, or request permissions. If the available context cannot answer the question, say so and suggest forwarding it to the manager.`
}

export function forwardedManagerQuestion(
  id: string,
  title: string,
  discussion: ManagerDiscussion,
): string {
  return [
    `## 讨论记录 / Discussion · ${id}: ${title}`,
    '用户将本议题的问答记录转给经理，请继续解答。此操作不代表决策答复或执行授权。\nThe user forwarded this discussion for clarification, not as a decision answer or authorization to act.',
    discussion.summary ? `### 摘要 / Summary\n${discussion.summary}` : '',
    ...discussion.messages.map((entry) =>
      [
        entry.question ? `### 用户 / User\n${entry.question}` : '',
        `### ${entry.mode === 'manager' ? '经理 / Manager' : '临时助手 / Temporary assistant'}\n${entry.answer ?? '(暂无回答 / No answer)'}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    ),
  ]
    .filter(Boolean)
    .join('\n\n')
}
