// 只给开发和验收用的连接参数：远端命令名换成测试夹具的替身、每个 ssh 会话上带几个环境变量
// （夹具的 sshd 靠 LITCH_FX_MODE 区分情形）。和桌面端的 LITCH_REMOTE_ADAPTER、ssh 配置里的 SetEnv 是一回事。
// 由测试链接写进 remote-dev.json（litch://remote?adapter=…&codex=…&env=名=值，env 可以给几个；
// litch://remote?reset=1 清掉），平时没有这个文件，用的是正式的命令名。
import { jsonFile } from '../shell/json-file'
import { checkName } from './ssh-script'

export interface RemoteDev {
  adapter?: string
  codex?: string
  env?: Record<string, string>
}

const file = jsonFile<RemoteDev>('remote-dev.json')

export const remoteDev = (): RemoteDev => file.read() ?? {}

/** 按测试链接的参数改。名字不合规矩的不收 */
export function setRemoteDev(params: URLSearchParams): void {
  if (params.get('reset') === '1') {
    file.remove()
    return
  }
  const next: RemoteDev = { ...remoteDev() }
  const adapter = params.get('adapter')
  if (adapter) next.adapter = checkName(adapter)
  const codex = params.get('codex')
  if (codex) next.codex = checkName(codex)
  const pairs = params.getAll('env')
  if (pairs.length > 0) {
    const env: Record<string, string> = {}
    for (const pair of pairs) {
      const at = pair.indexOf('=')
      const name = pair.slice(0, at)
      if (at > 0 && /^[A-Z_][A-Z0-9_]*$/.test(name)) env[name] = pair.slice(at + 1)
    }
    next.env = env
  }
  file.write(next)
}
