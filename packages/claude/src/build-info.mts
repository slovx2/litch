import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { harnessDeclaration } from './harness-declaration.mjs'
import { hostClaudeExecutable, hostClaudeVersion } from './host-claude.mjs'
import { resolveRuntimeConfig } from './runtime-config.mjs'
import { validateSandboxDependencies } from './sandbox-dependencies.mjs'

const require = createRequire(import.meta.url)
let cached: ReturnType<typeof collectBuildInfo> | undefined

function collectBuildInfo() {
  validateSandboxDependencies()
  const sdkRoot = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'))
  const sdk = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'))
  const cli = hostClaudeExecutable()
  return {
    engine: 'claude-code',
    protocolVersion: '0.157.1',
    nodeVersion: process.versions.node,
    sdkVersion: sdk.version as string,
    cliBuild: hostClaudeVersion(cli, sdk.claudeCodeVersion),
    cliSha256: createHash('sha256').update(readFileSync(cli)).digest('hex'),
    capabilities: [
      'history.pagination',
      'submission.idempotency',
      'dynamicTools',
      'nativeSession.rollback',
    ],
    releaseReady: false,
    // 结构化的声明：显示名、徽标、能力位、权限预设、支持的扩展。上面那份字符串清单原样留着。
    ...harnessDeclaration(resolveRuntimeConfig().type),
  }
}

export function buildInfo() {
  cached ??= collectBuildInfo()
  return cached
}
