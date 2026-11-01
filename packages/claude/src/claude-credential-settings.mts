import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isVersionAtLeast } from '../../shared/src/min-version.mjs'
import { claudeSettingsPath } from './claude-native-files.mjs'
import { claudeSettingSources } from './runtime-config.mjs'

// 官方包 2.1.312 首次把这四项加入项目 env 禁用清单（2.1.311 没有）；
// 已用两版真实请求核对：311 使用项目 token，312 使用用户 token。用户设置与启动环境不受限制。
export const PROJECT_SIGN_IN_DISABLED_SINCE = '2.1.312'
const signInKeys = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_OAUTH_CLIENT_ID',
])

export function isClaudeSignInKey(key: string): boolean {
  return signInKeys.has(key.toUpperCase())
}

export function ignoresProjectSignIn(version: string): boolean {
  return isVersionAtLeast(version, PROJECT_SIGN_IN_DISABLED_SINCE)
}

export interface CredentialSettingsLayer {
  path: string
  project: boolean
  settings: Record<string, unknown>
}

/** 与运行时选定的设置来源一致；保留层级，不把项目凭据误当成用户凭据。 */
export function credentialSettingsLayers(
  cwd: string,
  env = process.env,
): CredentialSettingsLayer[] {
  const directories: string[] = []
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    directories.unshift(directory)
    if (directory === dirname(directory)) break
  }
  const sources = claudeSettingSources(env)
  const userPath = sources.includes('user') ? claudeSettingsPath(env) : null
  const paths = [
    ...(sources.includes('user') ? [{ path: claudeSettingsPath(env), project: false }] : []),
    ...directories.flatMap((directory) => [
      ...(sources.includes('project')
        ? [{ path: join(directory, '.claude', 'settings.json'), project: true }]
        : []),
      ...(sources.includes('local')
        ? [{ path: join(directory, '.claude', 'settings.local.json'), project: true }]
        : []),
    ]),
  ]
  return (
    paths
      // 工作目录恰好是 HOME 时，同一份用户配置不再当作项目配置读一遍。
      .filter(({ path, project }) => (!project || path !== userPath) && existsSync(path))
      .map((layer) => {
        const settings: unknown = JSON.parse(readFileSync(layer.path, 'utf8'))
        if (!settings || typeof settings !== 'object' || Array.isArray(settings))
          throw new Error('Claude 设置必须是对象')
        return { ...layer, settings: settings as Record<string, unknown> }
      })
  )
}
