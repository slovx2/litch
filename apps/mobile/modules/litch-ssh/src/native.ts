// 原生那一层的 SSH 模块（Expo 原生模块 LitchSsh）。网页预览里换成 native.web.ts 的替身
import { requireNativeModule } from 'expo-modules-core'

export interface Native {
  probeHost(host: string, port: number, user: string): Promise<string>
  runScript(target: string, script: string, marker: string): Promise<string>
  openStream(id: string, target: string, script: string, marker: string): Promise<string>
  streamState(id: string): Promise<string>
  closeStream(id: string): Promise<void>
  generateEd25519Key(): Promise<string>
  inspectPrivateKey(privateKey: string, passphrase: string): Promise<string>
  enrollPair(target: string, line: string): Promise<string>
  pairConfirmCode(pairId: string, publicKey: string): Promise<string>
  pairPhoneId(publicKey: string): Promise<string>
}

export const native = requireNativeModule<Native>('LitchSsh')
