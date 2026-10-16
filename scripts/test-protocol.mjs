import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const artifacts = resolve(process.env.PROTOCOL_ARTIFACT_DIR ?? '.artifacts/protocol')
mkdirSync(artifacts, { recursive: true })
const runId = process.env.PROTOCOL_RUN_ID ?? randomUUID()
writeFileSync(
  resolve(artifacts, 'run.json'),
  JSON.stringify({ runId, startedAt: new Date().toISOString() }),
)
let schema =
  process.env.CODEX_SCHEMA_DIR ?? resolve('protocol/codex-app-server/0.157.1/json-schema')
if (!existsSync(schema)) {
  const cli = process.env.CODEX_TEST_BIN ?? 'codex'
  const version = execFileSync(cli, ['--version'], { encoding: 'utf8' }).trim()
  if (version !== 'codex-cli 0.157.1') throw new Error(`测试 CLI 版本错误: ${version}`)
  schema = resolve(artifacts, 'schema')
  execFileSync(cli, ['app-server', 'generate-json-schema', '--experimental', '--out', schema])
}
const info = execFileSync(
  process.execPath,
  ['packages/claude/dist/claude/src/adapter.mjs', '--runtime-info'],
  {
    encoding: 'utf8',
  },
)
writeFileSync(resolve(artifacts, 'versions.json'), info)
const command = process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : 'unshare'
const isolation =
  process.platform === 'darwin'
    ? [
        '-p',
        '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))',
        process.execPath,
      ]
    : [
        '--user',
        '--map-root-user',
        '--net',
        '/bin/sh',
        '-ec',
        'ip link set lo up; exec "$@"',
        'protocol-test',
        process.execPath,
      ]
const result = spawnSync(
  command,
  [
    ...isolation,
    '--test',
    '--test-reporter=spec',
    '--test-reporter=junit',
    `--test-reporter=${resolve('scripts/protocol-reporter.mjs')}`,
    '--test-reporter-destination=stdout',
    `--test-reporter-destination=${resolve(artifacts, 'junit.xml')}`,
    `--test-reporter-destination=${resolve(artifacts, 'executions.jsonl')}`,
    'packages/claude/dist/claude/test/native-protocol.test.mjs',
    'packages/claude/dist/claude/test/native-diagnostics.test.mjs',
    'packages/claude/dist/claude/test/native-catalog.test.mjs',
    'packages/claude/dist/claude/test/native-attachments.test.mjs',
    'packages/claude/dist/claude/test/native-projects.test.mjs',
    'packages/claude/dist/claude/test/native-experimental-features.test.mjs',
    'packages/claude/dist/claude/test/native-thread-shell.test.mjs',
    'packages/claude/dist/claude/test/native-context-injection.test.mjs',
    'packages/claude/dist/claude/test/native-review.test.mjs',
    'packages/claude/dist/claude/test/native-review-recovery.test.mjs',
    'packages/claude/dist/claude/test/native-skills.test.mjs',
    'packages/claude/dist/claude/test/native-skills-management.test.mjs',
    'packages/claude/dist/claude/test/native-hooks.test.mjs',
    'packages/claude/dist/claude/test/native-config.test.mjs',
    'packages/claude/dist/claude/test/native-rate-limits.test.mjs',
    'packages/claude/dist/claude/test/native-history.test.mjs',
    'packages/claude/dist/claude/test/native-timeline.test.mjs',
    'packages/claude/dist/claude/test/native-session.test.mjs',
    'packages/claude/dist/claude/test/native-sections.test.mjs',
    'packages/claude/dist/claude/test/native-rollback-failure.test.mjs',
    'packages/claude/dist/claude/test/native-revert.test.mjs',
    'packages/claude/dist/claude/test/native-queue.test.mjs',
    'packages/claude/dist/claude/test/native-submit-failure.test.mjs',
    'packages/claude/dist/claude/test/native-goals.test.mjs',
    'packages/claude/dist/claude/test/native-goal-execution.test.mjs',
    'packages/claude/dist/claude/test/native-events.test.mjs',
    'packages/claude/dist/claude/test/native-event-deletion.test.mjs',
    'packages/claude/dist/claude/test/native-turn-control.test.mjs',
    'packages/claude/dist/claude/test/native-turn-settings.test.mjs',
    'packages/claude/dist/claude/test/native-image-reference.test.mjs',
    'packages/claude/dist/claude/test/native-interactions.test.mjs',
    'packages/claude/dist/claude/test/native-interaction-wait.test.mjs',
    'packages/claude/dist/claude/test/native-approval-lifecycle.test.mjs',
    'packages/claude/dist/claude/test/native-plan.test.mjs',
    'packages/claude/dist/claude/test/native-permission-policy.test.mjs',
    'packages/claude/dist/claude/test/native-sandbox-policy.test.mjs',
    ...(process.platform === 'darwin'
      ? []
      : [
          'packages/claude/dist/claude/test/native-bash-sandbox.test.mjs',
          'packages/claude/dist/claude/test/native-request-permissions.test.mjs',
        ]),
    'packages/claude/dist/claude/test/native-cli-failure.test.mjs',
    'packages/claude/dist/claude/test/native-mcp.test.mjs',
    'packages/claude/dist/claude/test/native-mcp-management.test.mjs',
    'packages/claude/dist/claude/test/native-mcp-oauth.test.mjs',
    'packages/claude/dist/claude/test/native-mcp-elicitation.test.mjs',
    'packages/claude/dist/claude/test/native-mcp-elicitation-wait.test.mjs',
    'packages/claude/dist/claude/test/native-process.test.mjs',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      CODEX_SCHEMA_DIR: schema,
      PROTOCOL_ARTIFACT_DIR: artifacts,
      PROTOCOL_RUN_ID: runId,
    },
  },
)
if (result.error) throw result.error
let status = result.status ?? 1
if (process.platform === 'darwin') {
  // macOS 不支持嵌套 Seatbelt。此用例验证真正的工具级 OS 沙箱，单独运行。
  // ProtocolClient 仍使用临时 HOME、虚拟凭据和固定回环 Mock URL。
  writeFileSync(
    resolve(artifacts, 'sandbox-isolation.json'),
    JSON.stringify({
      platform: process.platform,
      outerNetworkIsolation: false,
      toolIsolation: 'sandbox-exec',
      modelEndpoint: 'loopback-only',
      reason: 'macOS 不支持嵌套 Seatbelt；Linux 在网络 namespace 内执行同一用例',
    }),
  )
  const sandbox = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=spec',
      '--test-reporter=junit',
      `--test-reporter=${resolve('scripts/protocol-reporter.mjs')}`,
      '--test-reporter-destination=stdout',
      `--test-reporter-destination=${resolve(artifacts, 'junit-sandbox.xml')}`,
      `--test-reporter-destination=${resolve(artifacts, 'executions-sandbox.jsonl')}`,
      'packages/claude/dist/claude/test/native-bash-sandbox.test.mjs',
      'packages/claude/dist/claude/test/native-request-permissions.test.mjs',
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        CODEX_SCHEMA_DIR: schema,
        PROTOCOL_ARTIFACT_DIR: artifacts,
        PROTOCOL_RUN_ID: runId,
      },
    },
  )
  if (sandbox.error) throw sandbox.error
  const executions = resolve(artifacts, 'executions-sandbox.jsonl')
  if (!existsSync(executions)) throw new Error('缺少真实 Bash 沙箱执行证据')
  appendFileSync(resolve(artifacts, 'executions.jsonl'), readFileSync(executions))
  status ||= sandbox.status ?? 1
}
process.exit(status)
