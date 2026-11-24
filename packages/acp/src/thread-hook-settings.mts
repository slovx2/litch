// 把 thread-hook.mts 挂到 Qwen 上：不改用户自己的设置文件，而是经 Qwen 的“系统默认设置”路径变量
//（QWEN_CODE_SYSTEM_DEFAULTS_PATH）给一份 Litch 生成的文件。Qwen 把各层设置里的 PreToolUse 数组接起来
//（不是顶掉），所以用户、项目里的钩子照常生效。原来的系统默认设置文件有内容时整份抄进来，只在末尾加一条钩子；
// 读不懂（不是 JSON 对象）时不挂，原样留给它自己读。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHELL_TOOL } from './thread-hook.mjs'

const DEFAULTS_VARIABLE = 'QWEN_CODE_SYSTEM_DEFAULTS_PATH'
const SETTINGS_VARIABLE = 'QWEN_CODE_SYSTEM_SETTINGS_PATH'

/** Qwen 在各平台上的系统设置文件；系统默认设置在它旁边的 system-defaults.json */
function systemSettings(): string {
  return process.platform === 'darwin'
    ? '/Library/Application Support/QwenCode/settings.json'
    : '/etc/qwen-code/settings.json'
}

/** 钩子命令：Qwen 在 POSIX 上用 bash -c 跑 */
export function hookCommand(argv: string[]): string {
  return argv.map((value) => `'${value.replaceAll("'", `'\\''`)}'`).join(' ')
}

/** 用户原来的系统默认设置文件在哪（Qwen 自己找的那一处） */
function originalDefaults(env: NodeJS.ProcessEnv): string {
  return (
    env[DEFAULTS_VARIABLE] ||
    join(dirname(env[SETTINGS_VARIABLE] || systemSettings()), 'system-defaults.json')
  )
}

/**
 * 起 agent 时要加的环境变量。不是 Qwen、不在设备下跑（没有设备套接字或 harness）、Windows（认不准 Qwen 用哪种
 * shell，见 prefixedCommand）、原来的系统默认设置读不懂时不挂，返回空对象。
 */
export function threadHookEnv(
  agent: string,
  env: NodeJS.ProcessEnv,
  home: string,
  hookScript = fileURLToPath(new URL('./thread-hook.mjs', import.meta.url)),
): NodeJS.ProcessEnv {
  const socket = env.LITCH_DEVICE_SOCKET
  const harness = env.LITCH_DEVICE_GITHUB_HARNESS
  if (agent !== 'qwen' || !socket || !harness || process.platform === 'win32') return {}
  const original = originalDefaults(env)
  let settings: Record<string, any> = {}
  if (existsSync(original)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(original, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      settings = parsed as Record<string, any>
    } catch {
      console.error(`[acp] ${original} 不是 JSON 对象，命令里不带 Litch 会话号`)
      return {}
    }
  }
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
  const existing = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []
  const ours = {
    matcher: SHELL_TOOL,
    hooks: [
      {
        type: 'command',
        name: 'litch-thread',
        command: hookCommand([process.execPath, hookScript, harness, socket]),
      },
    ],
  }
  const file = join(home, 'thread-hook', 'qwen-system-defaults.json')
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(
    file,
    `${JSON.stringify({ ...settings, hooks: { ...hooks, PreToolUse: [...existing, ours] } }, null, 2)}\n`,
    { mode: 0o600 },
  )
  return { [DEFAULTS_VARIABLE]: file }
}
