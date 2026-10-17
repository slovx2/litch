// 手机端 SSH 的 JS 接口。参数和结果在原生那一层都是 JSON 字符串，这里解析成对象
import { requireNativeModule } from 'expo-modules-core'

export interface SshTarget {
  host: string
  port: number
  user: string
  privateKey: string
  passphrase: string
  /** SHA256:… 的写法 */
  hostFingerprint: string
  /** 每个会话上设的环境变量（对面 sshd 放行的才生效） */
  env?: Record<string, string>
}

export interface RunResult {
  output: string
  marked: boolean
  code: number
  stderr: string
}

export interface StreamState {
  peer: string
  error: string
  code: number
  stderr: string
  closed: boolean
}

interface Native {
  probeHost(host: string, port: number, user: string): Promise<string>
  runScript(target: string, script: string, marker: string): Promise<string>
  openStream(id: string, target: string, script: string, marker: string): Promise<string>
  streamState(id: string): Promise<string>
  closeStream(id: string): Promise<void>
  generateEd25519Key(): Promise<string>
}

const native = requireNativeModule<Native>('LitchSsh')

export const ssh = {
  probeHost: (host: string, port: number, user: string) => native.probeHost(host, port, user),
  async runScript(target: SshTarget, script: string, marker: string): Promise<RunResult> {
    return JSON.parse(await native.runScript(JSON.stringify(target), script, marker)) as RunResult
  },
  async openStream(id: string, target: SshTarget, script: string, marker: string): Promise<string> {
    const opened = JSON.parse(
      await native.openStream(id, JSON.stringify(target), script, marker),
    ) as {
      url: string
    }
    return opened.url
  },
  async streamState(id: string): Promise<StreamState> {
    return JSON.parse(await native.streamState(id)) as StreamState
  },
  closeStream: (id: string) => native.closeStream(id),
}
