// 编出适配器的命令行（Go），放在仓库根目录的 bin/ 下。`npm run build` 的最后一步是它，各包的测试也先跑它：
// 带终端的命令和进程由命令行的 pty-bridge 子命令来起，而测试是直接用 node 起运行时的，没有命令行那一层，
// 引擎只能从自己的位置往上找到 bin/ 里的这一份（packages/shared/src/adapter-cli.mts）。
// 没改过源码时再编一次很快，Go 自己有缓存。
// 旁边放一个短名 litch-machine（machine 子命令）：命令行按调用时的名字认出它。
// 从源码装的（Homebrew 配方把整个 bin/ 装进 libexec）也就有了它。
import { spawnSync } from 'node:child_process'
import { copyFileSync, lstatSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const windows = process.platform === 'win32'
const repo = fileURLToPath(new URL('..', import.meta.url))
const target = `bin/codex-harness-adapter${windows ? '.exe' : ''}`
const result = spawnSync('go', ['build', '-o', target, './cmd/codex-harness-adapter'], {
  cwd: repo,
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
if (result.status === 0) {
  const short = join(repo, `bin/litch-machine${windows ? '.exe' : ''}`)
  let present = false
  try {
    present = windows || lstatSync(short).isSymbolicLink()
  } catch {}
  // Windows 上建链接要额外的权限，拷一份；别处是指向同目录那一份的相对链接，建过就不再动
  if (windows) copyFileSync(join(repo, target), short)
  else if (!present) {
    rmSync(short, { force: true })
    symlinkSync('codex-harness-adapter', short)
  }
}
