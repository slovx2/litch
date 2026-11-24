// Qwen 的工具前钩子（PreToolUse，由 thread-hook-settings.mts 挂上）。
// Qwen 一个 agent 进程跑所有会话，shell 命令在进程里自己起、继承进程的环境，没有会话号；设备就认不出命令属于
// 哪个会话，经理注入的 gh/Git 身份对它不生效。钩子带着会话号（session_id，就是 ACP 的 sessionId，也就是
// Litch 线程号）：已注入的会话，用 updatedInput 把 shell 命令改写成先 export LITCH_THREAD_ID 再跑原命令；
// 其余会话不改。Qwen 的 ACP 会话在权限检查和审批之前跑这个钩子，审批卡片上看到的是改写后的命令；模型的历史里
// 仍是它自己发的那条。出任何问题都输出空对象放行，不挡命令。
// Gemini 的 ACP 会话不跑钩子（0.38 的 acpSession 直接执行工具），不用这个办法。
//
// 用法：node thread-hook.mjs <harness> <设备套接字>，钩子输入从标准输入读。
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deviceGithubInjected } from '../../shared/src/device-github-environment.mjs'

export const SHELL_TOOL = 'run_shell_command'

/** 会话号只认这些字符：拼进命令时不用转义，也不会被当成 shell 语法 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * 写上会话号的命令（POSIX 上 Qwen 用 bash -c）。Windows 上 Qwen 视环境用 Git Bash、cmd 或 PowerShell，认不准，
 * 不改（null）。
 */
export function prefixedCommand(
  command: string,
  threadId: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!SAFE_ID.test(threadId) || platform === 'win32') return null
  return `export LITCH_THREAD_ID='${threadId}'\n${command}`
}

/** 钩子的输出：要改就给整份替换后的工具参数，不改就是空对象 */
export async function threadHook(
  harness: string,
  deviceSocket: string,
  input: unknown,
  injected: typeof deviceGithubInjected = deviceGithubInjected,
): Promise<Record<string, unknown>> {
  const value = input as {
    session_id?: unknown
    tool_name?: unknown
    tool_input?: unknown
  } | null
  const args = value?.tool_input as Record<string, unknown> | undefined
  if (
    value?.tool_name !== SHELL_TOOL ||
    typeof value.session_id !== 'string' ||
    !args ||
    typeof args !== 'object' ||
    typeof args.command !== 'string'
  )
    return {}
  const command = prefixedCommand(args.command, value.session_id)
  if (!command || !(await injected(harness, value.session_id, deviceSocket))) return {}
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...args, command } },
  }
}

async function main(): Promise<void> {
  const [, , harness = '', deviceSocket = ''] = process.argv
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    text += chunk
    if (text.length > 1_000_000) break
  }
  let output: Record<string, unknown> = {}
  try {
    output = await threadHook(harness, deviceSocket, JSON.parse(text))
  } catch {}
  process.stdout.write(JSON.stringify(output))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void main()
