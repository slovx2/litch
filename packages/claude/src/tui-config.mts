import { readFileSync } from 'node:fs'

export type ClaudeBackendMode = 'sdk' | 'tui'

/** Go 仍负责唯一写入；每个回合只读一次设备设置，活动回合保持自己的快照。 */
export function claudeBackendMode(env: NodeJS.ProcessEnv = process.env): ClaudeBackendMode {
  let value: unknown = env.CHA_CLAUDE_BACKEND_MODE ?? 'sdk'
  if (env.CHA_CLAUDE_BACKEND_SETTINGS) {
    try {
      const file = JSON.parse(readFileSync(env.CHA_CLAUDE_BACKEND_SETTINGS, 'utf8'))
      value = file.values?.['harness.claude-code.backend'] ?? value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('无法读取 Claude 后端设置，请修正设备设置文件后重试', { cause: error })
    }
  }
  if (value === 'sdk' || value === 'tui') return value
  throw new Error('Claude 后端必须是 sdk 或 tui')
}
