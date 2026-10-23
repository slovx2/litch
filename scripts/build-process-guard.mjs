// 编出 Claude 入口的守护进程（Go，cmd/claude-process-guard），各平台各一份，放进
// packages/claude/dist/claude/src/process-guard/<系统>-<架构>/。`npm run build --prefix packages/claude` 在 tsc 之后跑它。
//
// 放在 dist/claude/src 下面、各平台都编：只拷 dist/<包>/src 的暂存脚本（WakeQora 的 stage-test-cha.sh）
// 拿到的同一份产物在 macOS 和 Linux 容器里都能用；litch 自己的打包（adapter-stage.mjs、package-claude-runtime.sh）
// 只留目标平台那一份。入口按自己跑在哪个平台挑（packages/claude/src/native-process.mts）。
// 只用标准库和 x/sys，关掉 cgo，不挑宿主的 C 库；没改过源码时 Go 有缓存，再编很快。
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD_TARGETS = [
  'linux-amd64',
  'linux-arm64',
  'darwin-arm64',
  'darwin-amd64',
  'windows-amd64',
  'windows-arm64',
]

const repo = fileURLToPath(new URL('..', import.meta.url))
const out = join(repo, 'packages', 'claude', 'dist', 'claude', 'src', 'process-guard')

function build(target) {
  const [goos, goarch] = target.split('-')
  const binary = join(out, target, `claude-process-guard${goos === 'windows' ? '.exe' : ''}`)
  return new Promise((resolve, reject) => {
    const child = spawn(
      'go',
      [
        'build',
        '-trimpath',
        '-buildvcs=false',
        '-ldflags=-s -w',
        '-o',
        binary,
        './cmd/claude-process-guard',
      ],
      {
        cwd: repo,
        env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' },
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    )
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`守护进程（${target}）没有编译通过，报错在上面`)),
    )
  })
}

try {
  await Promise.all(GUARD_TARGETS.map(build))
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error(
      '这台电脑上找不到 go 命令，编不出 Claude 入口的守护进程（cmd/claude-process-guard）。\n' +
        '入口起 Claude Code CLI 都要经过它。请装上 Go（>= 1.26.10）再试。',
    )
  } else console.error(error.message)
  process.exit(1)
}
