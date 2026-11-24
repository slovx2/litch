// Go 入口已恢复宿主 PATH 并取得席位；这里只处理可能需要设备凭据的命令。

import { spawn } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deviceGithubEnvironment,
  githubThreadVariable,
} from '../../../shared/src/device-github-environment.mjs'

export function executableOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const path = env.PATH ?? env.Path ?? ''
  const names = process.platform === 'win32' ? [`${name}.exe`] : [name]
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) continue
    for (const candidate of names) {
      try {
        const target = realpathSync(join(directory, candidate))
        accessSync(target, process.platform === 'win32' ? constants.R_OK : constants.X_OK)
        if (statSync(target).isFile()) return target
      } catch {
        // 宿主目录已不存在，找下一个。
      }
    }
  }
}

/** 命令所在会话：各 harness 给命令的会话号变量不同（与 Go 入口 agentHasGithubContext 一致）。 */
export function githubCommandThread(env: NodeJS.ProcessEnv): string | undefined {
  const harness = env.LITCH_DEVICE_GITHUB_HARNESS
  return harness ? env[githubThreadVariable(harness)] : undefined
}

async function run(): Promise<void> {
  const [, , mode, ...args] = process.argv
  if (mode !== 'gh' && mode !== 'git') return
  const env = { ...process.env }
  const harness = env.LITCH_DEVICE_GITHUB_HARNESS
  const thread = githubCommandThread(env)
  const scope = harness && thread ? await deviceGithubEnvironment(harness, thread, env) : null
  const injected = scope?.ghPath
  const bin = mode === 'gh' && injected ? injected : executableOnPath(mode, env)
  if (!bin) {
    scope?.release()
    process.stderr.write(`${mode}: executable not found\n`)
    process.exitCode = 127
    return
  }
  // Windows 的二次批处理会改写参数。用 Node 入口直接驱动设备生成的 gh 助手。
  const script = process.platform === 'win32' && mode === 'gh' && extname(bin) === '.cmd'
  const command = script ? process.execPath : bin
  const commandArgs = script && scope?.ghArgs ? [...scope.ghArgs, ...args] : args
  const child = spawn(command, commandArgs, {
    stdio: 'inherit',
    env: scope?.env ?? env,
    windowsHide: true,
  })
  child.once('error', () => {
    scope?.release()
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    scope?.release(signal !== null)
    process.exitCode = code ?? 1
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void run().catch(() => {
    process.exitCode = 1
  })
}
