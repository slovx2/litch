// 编出适配器的命令行（Go），放在仓库根目录的 bin/ 下。`npm run build` 的最后一步是它，各包的测试也先跑它：
// 带终端的命令和进程由命令行的 pty-bridge 子命令来起，而测试是直接用 node 起运行时的，没有命令行那一层，
// 引擎只能从自己的位置往上找到 bin/ 里的这一份（packages/shared/src/adapter-cli.mts）。
// 没改过源码时再编一次很快，Go 自己有缓存。
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const target = `bin/codex-harness-adapter${process.platform === 'win32' ? '.exe' : ''}`
const result = spawnSync('go', ['build', '-o', target, './cmd/codex-harness-adapter'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'inherit',
})
if (result.error?.code === 'ENOENT') {
  // 不悄悄跳过：少了这一份，带终端的用例会一个个报“PTY 桥缺失”，看不出是缺 Go
  console.error(
    `这台电脑上找不到 go 命令，编不出适配器的命令行（${target}）。\n` +
      '带终端的命令和进程要用它的 pty-bridge 子命令，构建和测试都少不了它。请装上 Go（>= 1.26.6）再试。',
  )
  process.exit(1)
}
if (result.error) throw result.error
process.exitCode = result.status ?? 1
