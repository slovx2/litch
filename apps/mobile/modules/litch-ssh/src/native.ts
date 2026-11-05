// 原生那一层的 SSH 模块（Expo 原生模块 LitchSsh）。网页预览里换成 native.web.ts 的替身
import { requireOptionalNativeModule } from 'expo-modules-core'

export interface Native {
  tailscaleAvailable(): boolean
  connectionRoute(host: string, port: number, mode: string): Promise<string>
  tailscaleLogin(controlURL: string): Promise<string>
  tailscaleStatus(): Promise<string>
  tailscaleLogout(): Promise<void>
  tailscaleClear(): Promise<void>
  setBackgroundTimeout(minutes: number): void
  connectionPolicyState(): string
  addListener(
    event: 'onConnectionPolicy',
    listener: (event: { state: string }) => void,
  ): { remove(): void }
  batteryOptimization(): 'exempt' | 'restricted' | 'unknown'
  openBackgroundSettings(): boolean
  probeHost(host: string, port: number, user: string, tailscale: string): Promise<string>
  runScript(target: string, script: string, marker: string): Promise<string>
  openStream(id: string, target: string, script: string, marker: string): Promise<string>
  streamState(id: string): Promise<string>
  closeStream(id: string): Promise<void>
  generateEd25519Key(): Promise<string>
  inspectPrivateKey(privateKey: string, passphrase: string): Promise<string>
  enrollPair(target: string, line: string): Promise<string>
  pairConfirmCode(pairId: string, publicKey: string, approvalKey: string): Promise<string>
  pairPhoneId(publicKey: string): Promise<string>
  newApprovalKey(): Promise<string>
  approvalSign(seed: string, text: string): Promise<string>
  approvalFingerprint(approvalKey: string): Promise<string>
}

// 原生模块尚未提供的平台仍可打开设置；不能把不存在的能力报告成可用。
const unavailable = () => {
  throw new Error('[tailscaleUnavailable] Native SSH is unavailable')
}
export const native: Native =
  requireOptionalNativeModule<Native>('LitchSsh') ??
  new Proxy(
    {
      tailscaleAvailable: () => false,
      setBackgroundTimeout() {},
      connectionPolicyState: () =>
        JSON.stringify({ revision: 0, background: false, suspended: false }),
      addListener: () => ({ remove() {} }),
      batteryOptimization: () => 'unknown',
      openBackgroundSettings: () => false,
    } as unknown as Native,
    { get: (target, name) => target[name as keyof Native] ?? unavailable },
  )
