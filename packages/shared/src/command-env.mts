// 与 Codex protocol/src/shell_environment.rs 一致：子进程不得继承这些启动上下文变量。
const NON_INHERITABLE_ENV_VARS = [
  'CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN',
  'NODE_REPL_AUTH_TOKEN',
  'OPENAI_FEDERATION_RULE_ID',
  'OPENAI_IDENTITY_TOKEN_FILE',
  'OPENAI_WORKLOAD_IDENTITY_CONTEXT',
]

export function commandEnv(value: unknown): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (value && typeof value === 'object' && !Array.isArray(value))
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (raw == null) delete env[key]
      else env[key] = String(raw)
    }
  // 覆盖值之后再过滤，与原生一致（名称不区分大小写）。
  for (const key of Object.keys(env))
    if (NON_INHERITABLE_ENV_VARS.some((name) => name.toLowerCase() === key.toLowerCase()))
      delete env[key]
  return env
}
