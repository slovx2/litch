// npm test 预加载；helpers 也导入，直接跑用例或复用夹具的检查脚本同样隔离。
import '../../claude/test/fixtures/isolate-process.mjs'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, readdirSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

/** 编 Go 主进程时沿用的缓存与下载源；夹具换环境时也照这份名单往下传 */
export const GO_CACHE_ENV = ['GOMODCACHE', 'GOCACHE', 'GOPROXY'] as const

// 上面已把 HOME 换成临时目录，go 在这里会找不到本机的 module 缓存、构建缓存和 go env 文件里的下载源，
// 本机 go 比 go.mod 旧时还要重下工具链。调用者没给的几项，按账户的真实 HOME 问一次 go env 补上。
// 只给缓存和下载源，HOME 仍是临时目录；本地工具链只回答查询，不因 go.mod 切换版本。
const missing = GO_CACHE_ENV.filter((name) => !process.env[name])
if (missing.length) {
  const go = spawnSync('go', ['env', '-json', ...missing], {
    encoding: 'utf8',
    env: { ...process.env, HOME: userInfo().homedir, GOTOOLCHAIN: 'local' },
  })
  if (go.status === 0)
    for (const [name, value] of Object.entries(JSON.parse(go.stdout) as Record<string, string>))
      if (value) process.env[name] = value
}

process.env.LITCH_TEST_ISOLATED = '1'
process.env.CODEX_HOME = join(homedir(), '.codex')
process.env.CLAUDE_CONFIG_DIR = join(homedir(), '.claude')
process.env.XDG_CONFIG_HOME = join(homedir(), '.config')
process.env.XDG_DATA_HOME = join(homedir(), '.local', 'share')
process.env.XDG_STATE_HOME = join(homedir(), '.local', 'state')
process.env.XDG_CACHE_HOME = join(homedir(), '.cache')

// 设备用例还会编 Go 主进程，module 缓存目录只读。先恢复目录写权限，再交给共用夹具清理。
// 不跟随链接，避免 chmod 到临时 HOME 以外。
const home = homedir()
const writableDirectories = (directory: string): void => {
  const stat = lstatSync(directory)
  if (!stat.isDirectory()) return
  chmodSync(directory, stat.mode | 0o700)
  for (const name of readdirSync(directory)) writableDirectories(join(directory, name))
}
process.prependOnceListener('exit', () => {
  if (existsSync(home)) writableDirectories(home)
})
