// 上游模拟终端和本地权限桥测试：配置与用户环境隔离，仅复用 Go 编译/模块缓存。
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const config = JSON.parse(
  execFileSync('go', ['env', '-json', 'GOROOT', 'GOCACHE', 'GOMODCACHE'], { encoding: 'utf8' }),
)
const go = join(config.GOROOT, 'bin', process.platform === 'win32' ? 'go.exe' : 'go')
const home = mkdtempSync(join(tmpdir(), 'litch-tui-go-'))
try {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, 'codex'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    CLAUDE_CODE_TMPDIR: join(home, 'ct'),
    GOCACHE: config.GOCACHE,
    GOMODCACHE: config.GOMODCACHE,
    GOTOOLCHAIN: 'local',
    CGO_ENABLED: '0',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    TMPDIR: home,
    TEMP: home,
    TMP: home,
  }
  for (const [directory, target] of [
    ['third_party/magpie', './internal/claudetui'],
    ['cmd/claude-tui-helper', './...'],
  ]) {
    const result = spawnSync(go, ['test', target, '-count=1', '-v'], {
      cwd: join(repo, directory),
      env,
      stdio: 'inherit',
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${directory} 测试失败：${result.status}`)
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}
