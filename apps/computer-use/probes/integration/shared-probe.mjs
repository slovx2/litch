// 用户目录取系统账户记录，不取会被隔离测试覆盖的 HOME；所有工作树共用同一产物。
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { PROBE_IDENTITY } from './identity.mjs'

export function probeAppPath(explicit, env = process.env, accountHome = userInfo().homedir) {
  const configured = [env.LITCH_CU_PROBE_APP, env.LITCH_CU_PROBE_OUTPUT].filter(
    (value) => value !== undefined,
  )
  if (configured.some((value) => !isAbsolute(value))) throw new Error('探针覆盖路径必须是绝对路径')
  if (configured.length === 2 && resolve(configured[0]) !== resolve(configured[1]))
    throw new Error('LITCH_CU_PROBE_APP 与 LITCH_CU_PROBE_OUTPUT 必须指向同一探针')
  const path =
    explicit ??
    configured[0] ??
    join(
      accountHome,
      'Library/Application Support/Litch Tests/computer-use',
      `${PROBE_IDENTITY.helperName}.app`,
    )
  if (!isAbsolute(path) || basename(path) !== `${PROBE_IDENTITY.helperName}.app`)
    throw new Error(`需要独立 ${PROBE_IDENTITY.helperName}.app 的绝对路径`)
  return resolve(path)
}

// lockf 持有内核 flock 排他锁，原生探针运行时持有同文件的共享锁。保留锁文件避免换 inode。
// 持锁子进程只等 stdin EOF；父进程退出后自动释放，不靠 PID 文件或超时强抢锁。
export async function acquireProbeBuildLock(appPath) {
  mkdirSync(dirname(appPath), { recursive: true, mode: 0o700 })
  const child = spawn(
    '/usr/bin/lockf',
    [
      '-k',
      '-t',
      '0',
      `${appPath}.lock`,
      process.execPath,
      '-e',
      "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))",
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let errorText = ''
  child.stderr.on('data', (data) => {
    errorText += data
  })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) =>
      reject(
        new Error(`探针正在运行或构建中，未修改产物（锁退出码 ${code}）：${errorText.trim()}`),
      ),
    )
    child.stdout.once('data', () => resolve())
  })
  return async () => {
    child.stdin.end()
    await exited
  }
}
