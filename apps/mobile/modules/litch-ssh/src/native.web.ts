// 网页预览里的 SSH 替身：不连任何主机。生成钥匙、看钥匙、取主机指纹给固定的示例结果，
// 让加设备、扫码绑定这几页能走到下一步；真要连（跑脚本、开通道、登记）一律报连不到。
import type { Native } from './native'

const FINGERPRINT = 'SHA256:preview0000000000000000000000000000000000000'
const PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPreviewPreviewPreviewPreviewPreviewPrev litch-preview'
const unreachable = () => Promise.reject(new Error('[unreachable] 界面预览不连真实设备'))

export const native: Native = {
  probeHost: async () => JSON.stringify({ fingerprint: FINGERPRINT, keyType: 'ssh-ed25519' }),
  runScript: unreachable,
  openStream: unreachable,
  streamState: async () =>
    JSON.stringify({ peer: '', error: '界面预览不连真实设备', code: -1, stderr: '', closed: true }),
  closeStream: async () => {},
  generateEd25519Key: async () =>
    JSON.stringify({
      privateKey:
        '-----BEGIN OPENSSH PRIVATE KEY-----\npreview\n-----END OPENSSH PRIVATE KEY-----\n',
      publicKey: PUBLIC_KEY,
      fingerprint: FINGERPRINT,
    }),
  inspectPrivateKey: async () =>
    JSON.stringify({ publicKey: PUBLIC_KEY, fingerprint: FINGERPRINT }),
  enrollPair: unreachable,
  pairConfirmCode: async () => '000000',
  pairPhoneId: async () => 'preview',
}
