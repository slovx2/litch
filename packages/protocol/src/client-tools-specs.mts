// 客户端工具的定义汇总：建会话时 `thread/start.dynamicTools` 带哪几份，按命名空间从这里取。
// 每个命名空间的定义各放一个文件、各导出一个 ClientToolNamespaceSpec：
//   litch_browser   → client-tools-browser.mts（内置浏览器那条线提供）
//   litch_computer  → client-tools-computer.mts（Computer Use 那条线提供）
//   litch_machine   → client-tools-machine.mts（说明按会话生成，所以要给 MachineSpecContext）
//   litch_echo      → 就在这个文件里，只给测试用
// 合并时在下面 SPECS 里各加一行引用就接上了（见“合并时加在这里”那两行注释）。
// 这个文件只引用 client-tools.mts 和各命名空间的定义，核心（packages/core）和桌面外壳都直接引用它。
import { CLIENT_TOOL_NAMESPACE, type ClientToolNamespaceSpec } from './client-tools.mjs'

import { BROWSER_TOOLS } from './client-tools-browser.mjs'
import { COMPUTER_TOOLS } from './client-tools-computer.mjs'
import { type MachineSpecContext, machineToolsSpec } from './client-tools-machine.mjs'

/** echo 工具的参数 */
export interface EchoArguments {
  /** 原样带回来的字 */
  text: string
  /** 为真时结果里多带一张小图（打通“结果里有图片”这一段） */
  image?: boolean
  /** 为真时先在对话里出一张卡片问用户（打通 ask 这一段），用户拒绝就回 declined */
  ask?: boolean
}

/**
 * 测试用的命名空间：一个 echo 工具，原样回文字，可选回一张小图。用来打通“建会话带工具 → 模型调用 →
 * 引擎发 item/tool/call → 核心 → 主进程 → 执行器 → 结果回到模型”这一整条链路。
 * 平时不声明，只有测试或者开了环境变量（LITCH_CLIENT_TOOLS_ECHO=1）时桌面端才报它
 */
export const ECHO_TOOLS: ClientToolNamespaceSpec = {
  type: 'namespace',
  name: CLIENT_TOOL_NAMESPACE.echo,
  description: 'Litch test tools. Only used to check that client tool calls reach the desktop.',
  tools: [
    {
      type: 'function',
      name: 'echo',
      description:
        'Return the given text unchanged. Set image to true to also get a tiny test image back.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to send back.' },
          image: { type: 'boolean', description: 'Also return a tiny PNG image.' },
          ask: {
            type: 'boolean',
            description: 'Ask the user for permission before answering.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  ],
}

/** 各命名空间的定义。键是命名空间 */
const SPECS: Record<string, ClientToolNamespaceSpec> = {
  [ECHO_TOOLS.name]: ECHO_TOOLS,
  [BROWSER_TOOLS.name]: BROWSER_TOOLS,
  [COMPUTER_TOOLS.name]: COMPUTER_TOOLS,
}

/** 建会话时知道的、按会话生成定义要用的东西。没有就给 null，说明里不写具体的机器 */
export interface ClientToolSpecContext {
  machine: MachineSpecContext | null
}

/** 一个命名空间的定义。没有这一份（还没接上的、不认识的）是 null */
export function clientToolSpec(
  namespace: string,
  context: ClientToolSpecContext | null = null,
): ClientToolNamespaceSpec | null {
  if (namespace === CLIENT_TOOL_NAMESPACE.machine) return machineToolsSpec(context?.machine ?? null)
  return Object.hasOwn(SPECS, namespace) ? (SPECS[namespace] ?? null) : null
}

/** 这几个命名空间的定义，按给的先后，没有定义的跳过。建会话时带的 dynamicTools 就是它 */
export function clientToolSpecs(
  namespaces: readonly string[],
  context: ClientToolSpecContext | null = null,
): ClientToolNamespaceSpec[] {
  const specs: ClientToolNamespaceSpec[] = []
  for (const namespace of new Set(namespaces)) {
    const spec = clientToolSpec(namespace, context)
    if (spec) specs.push(spec)
  }
  return specs
}
