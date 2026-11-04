import { join } from 'node:path'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'

export interface Backend {
  handle(peer: RpcPeer, message: WireMessage): void | Promise<void>
  closePeer(peer: RpcPeer): void
  close(): Promise<void>
}
// dist/antigravity/src → packages → acp/dist/acp/src。开发构建与安装包保留同一布局。
export const acpModuleUrl = (moduleUrl = import.meta.url): URL =>
  new URL('../../../../acp/dist/acp/src/server.mjs', moduleUrl)
export async function loadAcp(
  home: string,
  environment: NodeJS.ProcessEnv,
  moduleUrl = acpModuleUrl(),
): Promise<Backend> {
  const module = (await import(moduleUrl.href)) as {
    AcpServer: new (home: string, env: NodeJS.ProcessEnv) => Backend
  }
  const env: NodeJS.ProcessEnv = {
    ...environment,
    CHA_ACP_AGENT: 'agy',
    CHA_ACP_HOME: join(home, 'acp'),
  }
  // 订阅后端只交给官方 CLI 登录；不把 API key 模式的 key 自动传入另一计费身份。
  delete env.GEMINI_API_KEY
  delete env.GOOGLE_API_KEY
  return new module.AcpServer(join(home, 'acp'), env)
}
