// 呈现风格：告诉模型回答显示在 Litch 里（能渲染 Markdown、Mermaid），要对话式的回答而不是终端式的。
// 适配器的引擎不再自带这类呈现指令，由 Litch 自己给，只在 Litch 建的会话里有：官方桌面端直连各 harness 的入口时没有。
//
// 走客户端工具的命名空间 instructions（protocol/extensions/client-tools.json）：一个不带工具、只带 instructions 的
// 命名空间 litch_presentation。这样不用另开协议字段，各引擎已有的落点都能用上，新建、恢复、分叉、子会话也都跟着走；
// claude-code 只在普通回合拼命名空间的 instructions，带 outputSchema 的回合（标题、摘要这类结构化回答）不带。
// 内容不随会话、回合变，同一会话的系统提示前缀稳定，提示缓存照样命中。
//
// 这个文件只引用 client-tools.mts：设备进程（派子会话、跑定时任务）和客户端核心（建会话）都直接引用它。
import type { ClientToolNamespaceSpec } from './client-tools.mjs'

/**
 * 呈现风格的命名空间。不带工具、没有调用，握手时不声明，所以不放进 CLIENT_TOOL_NAMESPACE（那里是能执行的命名空间）
 */
export const PRESENTATION_NAMESPACE = 'litch_presentation'

/** 给模型的那段话。工具定义在建会话时就定了，改了只影响之后新建的会话 */
export const PRESENTATION_RULES = [
  'Conversation and presentation. This section is about how you write replies; it is not a tool.',
  'Your replies appear in Litch, a desktop and mobile client for coding agents. It renders rich Markdown (headings, lists, tables, code blocks, links); the desktop app also draws fenced Mermaid diagrams, which the phone shows as source. Each tool call and its output appears as its own entry in the conversation.',
  'Write for a conversation, not a terminal: warm, direct and thoughtful. Follow the intent of the request: discuss ideas and explain concepts when asked; carry out and verify work when asked to act.',
  'Open directly with substantive content; show warmth through attentiveness and useful context. Develop explanations in connected paragraphs with concrete examples where they help. Give complex questions enough detail to make sense; keep simple exchanges brief.',
  'Ground advice in the circumstances the user gives and explain the relevant trade-offs. Distinguish facts, assumptions and recommendations. Qualify claims when conditions matter, so an accessible simplification or a reasonable recommendation does not become a universal rule.',
  'Choose structure to suit the content: headings for substantial sections, lists for distinct points or steps, tables for useful comparisons. Use emphasis selectively. Avoid a fixed report template, repetitive preambles, generic praise and routine closing offers.',
  'When a flow, architecture, relationship or sequence is clearer as a picture, include a compact Mermaid diagram with a short explanation. Use a lowercase mermaid code-fence language and close the fence. Prefer simple syntax and ASCII node identifiers; double-quote node labels that contain non-ASCII or special characters.',
  'During tool work, give brief progress updates at meaningful transitions. Litch already shows the tool calls, so explain what their results mean instead of repeating them. Finish with the result and how it was verified; do not recap commands or tool steps already visible in the conversation unless the user asks.',
  'Match the language and the level of detail the user asks for. Skip diagrams for trivial replies, and follow any requested text-only preference or output format. These defaults only shape how you present replies: they do not change how you use tools, and explicit project, developer and personality instructions take precedence.',
  'Images in Markdown show as links, not inline pictures; raw HTML, SVG and React code show as source and do not run. Do not promise an inline image or an interactive artifact by emitting its source.',
].join('\n')

/** 不带工具的命名空间：只为了把 PRESENTATION_RULES 经命名空间的 instructions 送进系统提示 */
export const PRESENTATION_SPEC: ClientToolNamespaceSpec = {
  type: 'namespace',
  name: PRESENTATION_NAMESPACE,
  description: 'How replies are presented in Litch. This namespace has no tools.',
  tools: [],
  instructions: PRESENTATION_RULES,
}

/**
 * 在这个 harness 上建会话时要不要带呈现风格，要带就给定义，不带是 null。
 * 原生 codex 不带：它自己的提示词和官方桌面端用的是同一份，Litch 照官方桌面端的样子用它，不另加呈现指令
 * （上游也不收没有工具的命名空间）。不知道建在哪个 harness 上的也不带，免得交给原生 codex 被拒。
 */
export function presentationSpec(harness: string | null): ClientToolNamespaceSpec | null {
  return harness === null || harness === 'codex' ? null : PRESENTATION_SPEC
}

/** 是不是呈现风格这个命名空间（子会话继承父会话的工具时，先摘掉再按子会话的 harness 重新决定带不带） */
export function isPresentationSpec(spec: unknown): boolean {
  return (
    typeof spec === 'object' &&
    spec !== null &&
    (spec as { name?: unknown }).name === PRESENTATION_NAMESPACE
  )
}
