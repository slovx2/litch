import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 测试进程只从宿主继承这些系统变量。模型凭据、代理、个人状态目录和别的工具开关一律不要：
// 被测引擎原样把 process.env 交给真实 CLI，宿主多一个 OPENROUTER_API_KEY 都会改掉它的行为。
const SYSTEM = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'TZ',
  'USER',
  'LOGNAME',
  'SHELL',
  'CI',
  // node --test 交给每个用例文件子进程的上下文（删了它子进程就不往父进程报结果）和覆盖率目录
  'NODE_TEST_CONTEXT',
  'NODE_V8_COVERAGE',
  // Windows 上起子进程离不开的几项
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'SYSTEMDRIVE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
]

/**
 * 把 process.env 收成白名单：系统变量加上调用方点名的测试开关（比如指定 CLI 的路径），
 * 再换一个临时 HOME，进程退出时删掉。返回这个 HOME。Windows 的变量名不分大小写，按大写比较。
 */
export function keepSystemEnv(allowed: readonly string[]): string {
  const keep = new Set([...SYSTEM, ...allowed].map((name) => name.toUpperCase()))
  for (const name of Object.keys(process.env))
    if (!keep.has(name.toUpperCase())) delete process.env[name]
  const home = mkdtempSync(join(tmpdir(), 'litch-test-home-'))
  process.once('exit', () => rmSync(home, { recursive: true, force: true }))
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.CODEX_HOME = join(home, '.codex')
  process.env.XDG_CONFIG_HOME = join(home, '.config')
  process.env.XDG_DATA_HOME = join(home, '.local', 'share')
  process.env.XDG_STATE_HOME = join(home, '.local', 'state')
  process.env.XDG_CACHE_HOME = join(home, '.cache')
  return home
}
