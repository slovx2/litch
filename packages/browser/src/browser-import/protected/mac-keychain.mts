import { join } from 'node:path'
import type { BrowserId } from '../types.mjs'
import type { RunCommand } from './process.mjs'
import { checkCancelled, ReadFault } from './result.mjs'

export interface MacKeychainRuntime {
  executable: string
  directory: string
  run: RunCommand
}

export async function readMacKeychain(
  browser: BrowserId,
  signal: AbortSignal,
  runtime?: MacKeychainRuntime,
): Promise<Buffer> {
  checkCancelled(signal)
  if (!runtime) throw new ReadFault('unsupported')
  if (!['chrome', 'edge', 'brave', 'arc', 'chromium', 'vivaldi'].includes(browser))
    throw new ReadFault('unsupported')
  // 不继承 NODE_OPTIONS、NODE_PATH、DYLD_* 或 Electron 日志开关，避免预加载或日志记录碰到密钥。
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
  for (const key of [
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    '__CF_USER_TEXT_ENCODING',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const output = await runtime.run(
    runtime.executable,
    [join(runtime.directory, 'keychain-helper.mjs')],
    Buffer.from(browser),
    signal,
    { env },
  )
  try {
    checkCancelled(signal)
    if (output.code !== 0)
      throw new ReadFault(
        output.code === 2 ? 'denied' : output.code === 3 ? 'unsupported' : 'failed',
      )
    if (!output.stdout.length || output.stdout.length > 65536) throw new ReadFault('failed')
    // 原始字节没有 security -w 添加的换行，不得 trim 或删最后一个字节。
    return Buffer.from(output.stdout)
  } finally {
    output.stdout.fill(0)
    output.stderr.fill(0)
  }
}
