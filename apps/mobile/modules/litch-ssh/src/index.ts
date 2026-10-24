// 手机端 SSH 的 JS 接口。参数和结果在原生那一层都是 JSON 字符串，这里解析成对象。
// 失败时原生那头的错误文字以 `[种类] ` 开头（mobile/sshtransport/errors.go），认种类见 src/platform/ssh-errors.ts
import { native } from './native'

export interface SshTarget {
  host: string
  port: number
  user: string
  privateKey: string
  passphrase: string
  /** SHA256:… 的写法 */
  hostFingerprint: string
  /** 扫码绑定的一次性钥匙：ed25519 的 32 字节种子（base64url）。给了就不看 privateKey */
  seed?: string
  /** 只协商这一种主机钥匙（例如 ssh-ed25519） */
  hostKeyType?: string
  /** 每个会话上设的环境变量（对面 sshd 放行的才生效） */
  env?: Record<string, string>
  /** 扫码绑定的 Tailscale 方式：登进去后执行的登记命令（二维码里的 c） */
  enrollCommand?: string
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

/** 主机给的钥匙 */
export interface HostKey {
  /** SHA256:… 的写法，和 ssh-keygen -l -E sha256 给的一样 */
  fingerprint: string
  /** 算法，例如 ssh-ed25519 */
  keyType: string
}

/** 一把钥匙。privateKey 只有生成时才有 */
export interface KeyDescription {
  privateKey?: string
  /** authorized_keys 里的一行 */
  publicKey: string
  fingerprint: string
}

/** 批准钥匙：种子（32 字节，标准 base64，只进安全存储）、公钥（32 字节，标准 base64）、指纹 */
export interface ApprovalKeyDescription {
  seed: string
  approvalKey: string
  fingerprint: string
}

export const ssh = {
  async probeHost(host: string, port: number, user: string): Promise<HostKey> {
    return JSON.parse(await native.probeHost(host, port, user)) as HostKey
  },
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
  async generateEd25519Key(): Promise<Required<KeyDescription>> {
    return JSON.parse(await native.generateEd25519Key()) as Required<KeyDescription>
  },
  async inspectPrivateKey(privateKey: string, passphrase: string): Promise<KeyDescription> {
    return JSON.parse(await native.inspectPrivateKey(privateKey, passphrase)) as KeyDescription
  },
  /**
   * 扫码绑定：登进去（一次性钥匙，或 Tailscale 方式下手机自己的钥匙并执行 enrollCommand），
   * 往 pair-enroll 的标准输入写一行，返回它写回的那一行（最多等 3 分钟）
   */
  enrollPair: (target: SshTarget, line: string): Promise<string> =>
    native.enrollPair(JSON.stringify(target), line),
  /** 6 位确认码，和电脑上显示的那个比对。approvalKey 给空串是不带批准公钥（二维码里没有 a） */
  pairConfirmCode: (pairId: string, publicKey: string, approvalKey: string) =>
    native.pairConfirmCode(pairId, publicKey, approvalKey),
  /** 这部手机在对面钥匙行里的编号 */
  pairPhoneId: (publicKey: string) => native.pairPhoneId(publicKey),
  /** 生成一把批准钥匙（手机批准登录用，和 ssh 钥匙无关） */
  async newApprovalKey(): Promise<ApprovalKeyDescription> {
    return JSON.parse(await native.newApprovalKey()) as ApprovalKeyDescription
  },
  /** 用批准钥匙的种子对 text 签名（ed25519），标准 base64 */
  approvalSign: (seed: string, text: string) => native.approvalSign(seed, text),
  /** 批准公钥的指纹：4 组、每组 4 个十六进制字 */
  approvalFingerprint: (approvalKey: string) => native.approvalFingerprint(approvalKey),
}
