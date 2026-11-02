// 只认 Maestro 2.3.0 的结构化失败命令；UI 断言即便伴随掉线也不能重试。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function infrastructureRetryReason(directory, appId, reverseLost) {
  const commandFiles = readdirSync(directory).filter((name) => /^commands-.*\.json$/.test(name))
  if (!commandFiles.length) return null
  const failed = []
  for (const file of commandFiles) {
    let commands
    try {
      commands = JSON.parse(readFileSync(join(directory, file), 'utf8'))
    } catch {
      return null
    }
    if (!Array.isArray(commands)) return null
    failed.push(...commands.filter((entry) => entry.metadata?.status === 'FAILED'))
  }
  const launches = failed.filter((entry) => entry.command?.launchAppCommand?.appId === appId)
  if (!launches.length) return null
  // runFlow 是 fresh 的外层容器；其他失败命令（特别是 visible/assert）一律不重跑。
  if (failed.some((entry) => !launches.includes(entry) && !entry.command?.runFlowCommand))
    return null
  const logFile = join(directory, 'maestro.log')
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const offline =
    launches.some((entry) => /device offline/i.test(JSON.stringify(entry.metadata.error ?? {}))) ||
    /(?:IOException|host:transport|adb)[^\r\n]*device offline/i.test(log)
  if (!offline && !reverseLost) return null
  return [
    'launchApp 失败',
    ...(offline ? ['device offline'] : []),
    ...(reverseLost ? ['本次尝试的 ADB reverse 映射丢失'] : []),
  ].join('；')
}

/** 等设备上线后逐条恢复并核对映射；任何一步失败都不能进入第二次 flow。 */
export async function recoverAdb(run, rules) {
  await run('wait-for-device')
  if ((await run('get-state')).trim() !== 'device') throw new Error('ADB 设备仍未上线')
  for (const pair of rules) await run('reverse', ...pair)
  const listed = await run('reverse', '--list')
  const restored = listed
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).slice(-2).join(' '))
  if (rules.some((pair) => !restored.includes(pair.join(' '))))
    throw new Error('ADB reverse 未恢复完整')
}
