// npm test 预加载；helpers 也导入，直接跑用例或复用夹具的检查脚本同样隔离。
import '../../claude/test/fixtures/isolate-process.mjs'
import { chmodSync, existsSync, lstatSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
