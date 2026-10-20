import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeConfigDir } from './claude-native-files.mjs'
import { type ClaudeSettingSource, claudeSettingSources } from './runtime-config.mjs'

// Claude Code 自己的几层设置文件，按 CLI 合并的先后排（后面的盖前面的），只列 CHA_CLAUDE_SETTING_SOURCES
// 选中的那几层。托管策略（managed-settings.json）不在这里：它比入口传的设置还优先，入口盖不过它。

export function settingLayerFiles(
  cwd: string,
  sources: readonly ClaudeSettingSource[] = claudeSettingSources(),
): Array<{ source: ClaudeSettingSource; path: string }> {
  const all: Array<{ source: ClaudeSettingSource; path: string }> = [
    { source: 'user', path: join(claudeConfigDir(), 'settings.json') },
    { source: 'project', path: join(cwd, '.claude', 'settings.json') },
    { source: 'local', path: join(cwd, '.claude', 'settings.local.json') },
  ]
  return all.filter((layer) => sources.includes(layer.source))
}

/** 选中的几层设置里 env 配的这个变量（最后一层配了的为准）；都没配是 undefined。读不了、格式不对的层跳过 */
export function settingsEnvValue(cwd: string, key: string): string | undefined {
  let value: string | undefined
  for (const { path } of settingLayerFiles(cwd)) {
    try {
      const env = (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)?.env
      const entry =
        env && typeof env === 'object' ? (env as Record<string, unknown>)[key] : undefined
      if (typeof entry === 'string') value = entry
    } catch {}
  }
  return value
}
