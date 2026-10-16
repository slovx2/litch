import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { cliCommand } from '../../shared/src/host-cli.mjs'
import { hostPi } from '../src/versions.mjs'

// 启动与适配器同一份的真实官方 CLI，只传临时配置和必要环境；不继承宿主模型凭据。
export async function continueWithCli(path: string, cwd: string, agentDir: string): Promise<void> {
  const [command, ...args] = cliCommand(hostPi().cli, ['--mode', 'rpc', '--session', path])
  const child = spawn(command!, args, {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: dirname(agentDir), PI_CODING_AGENT_DIR: agentDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = '',
    diagnostics = '',
    sequence = 0
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  let settled = () => {}
  const done = new Promise<void>((resolve) => {
    settled = resolve
  })
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000)
  child.stderr.on('data', (chunk) => {
    diagnostics += chunk
  })
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (message.type === 'agent_settled') settled()
      if (message.type === 'response') {
        const request = pending.get(message.id)
        pending.delete(message.id)
        if (message.success) request?.resolve(message.data)
        else request?.reject(new Error(message.error))
      }
    }
  })
  child.once('exit', () => {
    for (const p of pending.values()) p.reject(new Error(`CLI 提前退出: ${diagnostics}`))
  })
  const call = (type: string, params: Record<string, unknown> = {}) =>
    new Promise((resolve, reject) => {
      const id = String(++sequence)
      pending.set(id, { resolve, reject })
      child.stdin.write(JSON.stringify({ id, type, ...params }) + '\n')
    })
  try {
    await call('get_state')
    await call('set_session_name', { name: '真实 CLI 名称' })
    await call('prompt', { message: 'CLI executable continuation' })
    await Promise.race([
      done,
      exited.then(() => {
        throw new Error('CLI 未完成模型回合')
      }),
    ])
    child.stdin.end()
    await exited
    if (child.exitCode !== 0) throw new Error(`CLI 退出失败: ${diagnostics}`)
  } finally {
    clearTimeout(timeout)
    child.kill('SIGTERM')
    await exited
  }
}
