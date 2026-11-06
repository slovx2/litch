// 网页预览里的 SSH 替身：不连任何主机。生成钥匙、看钥匙、取主机指纹给固定的示例结果，
// 两个配对场景模拟登录与登记成功；其他登记、跑脚本和开通道一律报连不到。
import type { Native } from './native'

const FINGERPRINT = 'SHA256:preview0000000000000000000000000000000000000'
const PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPreviewPreviewPreviewPreviewPreviewPrev litch-preview'
const unreachable = () => Promise.reject(new Error('[unreachable] 界面预览不连真实设备'))
const scene = new URLSearchParams(location.search).get('scene')
const pairingScene = scene === 'pair-ts-account' || scene === 'pair-ts-login'
let signedIn = scene === 'pair-ts-account'
let switched = false
const tailStatus = () =>
  JSON.stringify({
    state: signedIn ? 'connected' : 'needsLogin',
    hostname: 'preview-phone',
    tailnet: signedIn ? (switched ? 'engineering.example' : 'personal.example') : '',
    authURL: '',
    controlURL: 'https://controlplane.tailscale.com',
    hosts: ['build-preview', 'build-preview.example.ts.net', '100.100.10.20'],
  })

export const native: Native = {
  tailscaleAvailable: () => pairingScene,
  connectionRoute: async () => '',
  tailscaleLogin: async () => {
    if (!pairingScene) return unreachable()
    signedIn = true
    return tailStatus()
  },
  tailscaleStatus: async () => (pairingScene ? tailStatus() : unreachable()),
  tailscaleLogout: async () => {
    if (!pairingScene) return unreachable()
    signedIn = false
    switched = true
  },
  tailscaleClear: unreachable,
  setBackgroundTimeout() {},
  connectionPolicyState: () => JSON.stringify({ revision: 0, background: false, suspended: false }),
  addListener: () => ({ remove() {} }),
  batteryOptimization: () => 'unknown',
  openBackgroundSettings: () => false,
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
  enrollPair: async () => {
    if (!pairingScene) return unreachable()
    return JSON.stringify({ ok: true, phoneId: 'preview' })
  },
  pairConfirmCode: async () => '000000',
  pairPhoneId: async () => 'preview',
  // 批准钥匙：示例的种子和公钥是协议里的测试向量，签名给一串格式对的占位
  newApprovalKey: async () =>
    JSON.stringify({
      seed: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
      approvalKey: 'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=',
      fingerprint: '65b6 0673 d6ed 884b',
    }),
  approvalSign: async () => `${'A'.repeat(86)}==`,
  approvalFingerprint: async () => '65b6 0673 d6ed 884b',
}
