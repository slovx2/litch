// 起 ssh 的共用参数。单独一个文件、只引类型：远端 localhost 的端口转发（forward.mts）和它的单元测试
// 也用这一份，测试打包时不用带上核心。
import type { RemoteTarget } from '@litch/core'

/**
 * ssh 的共用选项和目的地（不含远程命令）。有别名就只传别名，其余全交给用户自己的 ssh 配置，
 * 跳板机、代理命令、硬件密钥自然可用。BatchMode 让 ssh 在需要人输入（密码、口令、确认主机密钥）时直接失败，
 * 而不是挂在那里等。远端 localhost 的端口转发（forward.mts）用的也是这一份
 */
export function sshBase(target: RemoteTarget): { options: string[]; destination: string } {
  const options = [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=20',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=12',
  ]
  // 换一份 ssh 配置文件：开发和自检用，平时不设
  const config = process.env.LITCH_SSH_CONFIG
  if (config) options.unshift('-F', config)
  let destination: string
  if (target.kind === 'alias') {
    destination = target.alias
  } else {
    if (target.port) options.push('-p', String(target.port))
    if (target.keyFile) options.push('-i', target.keyFile, '-o', 'IdentitiesOnly=yes')
    destination = target.user ? `${target.user}@${target.host}` : target.host
  }
  // 核心已经检查过这些值；这里再挡一次，绝不让一个以减号开头的目标被 ssh 当成选项
  if (destination.startsWith('-')) throw new Error('目标主机不合规')
  return { options, destination }
}
