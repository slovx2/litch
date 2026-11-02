// CI 按测试文件分片；构建在外面完成。每片独立 HOME，不改变包内的隔离预加载与超时。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [suite, shard = '1/1'] = process.argv.slice(2)
const suites = {
  claude: {
    dir: 'packages/claude/dist/claude/test',
    suffix: '.mjs',
    args: [
      '--import',
      './packages/claude/dist/claude/test/fixtures/isolate-process.mjs',
      '--test-force-exit',
      '--test-concurrency=4',
      '--test-timeout=600000',
    ],
  },
  pi: {
    dir: 'packages/pi/dist/pi/test',
    suffix: '.test.mjs',
    args: ['--import', './packages/pi/dist/pi/test/setup.mjs'],
  },
  device: {
    dir: 'packages/device/dist/device/test',
    suffix: '.test.mjs',
    args: ['--test-timeout=300000'],
  },
}
const config = suites[suite]
if (!config || !/^[1-9]\d*\/[1-9]\d*$/.test(shard))
  throw new Error('用法：test-shard.mjs claude|pi|device N/M')
const [index, total] = shard.split('/').map(Number)
if (index > total) throw new Error('分片编号超过总数')
const files = readdirSync(config.dir)
  .filter((file) => file.endsWith(config.suffix))
  .sort()
// 显式列出这片的文件，新增用例自动进入集合，不依赖维护一份容易漏项的名单。
const selected = files
  .filter((_, at) => at % total === index - 1)
  .map((file) => join(config.dir, file))
if (!selected.length) throw new Error('空测试分片')
console.log(`${suite} ${shard}: ${selected.length}/${files.length} files\n${selected.join('\n')}`)
const testHome = mkdtempSync(join(tmpdir(), `litch-ci-${suite}-${index}-`))
try {
  const env = {
    ...process.env,
    HOME: testHome,
    USERPROFILE: testHome,
    CODEX_HOME: join(testHome, '.codex'),
  }
  for (const key of Object.keys(env)) {
    if (
      /^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_USE_)/.test(key) ||
      ['CLAUDE_CONFIG_DIR', 'CHA_CLAUDE_HOME', 'LITCH_STATE_DIR', 'PI_CODING_AGENT_DIR'].includes(
        key,
      )
    )
      delete env[key]
  }
  // 嵌套测试验收执行器时，不能继承父测试运行器的内部子进程标记。
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [...config.args, '--test', ...selected], {
    stdio: 'inherit',
    env,
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(testHome, { recursive: true, force: true })
}
