import type { AcpControlsRequests } from '../../../protocol/src/acp-controls.mjs'
import { ChannelError } from '../channel/protocol.mjs'
import type { RpcRequestOptions } from '../connection/rpc.mjs'

type Method = keyof Pick<
  AcpControlsRequests,
  | 'litch/acp/auth/read'
  | 'litch/acp/auth/authenticate'
  | 'litch/acp/auth/continue'
  | 'litch/acp/auth/cancel'
  | 'litch/acp/auth/logout'
>

/** 只转交显式账号操作，参数不接受密钥、令牌或任意附加字段。 */
export function createAcpAuth(host: {
  online(): boolean
  supported(harness: string): boolean
  request<M extends Method>(
    method: M,
    params: AcpControlsRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<AcpControlsRequests[M]['result']>
  fail(error: unknown): ChannelError
}) {
  async function call<M extends Method>(method: M, params: AcpControlsRequests[M]['params']) {
    if (!host.online()) throw new ChannelError('offline', 'Device disconnected')
    if (!host.supported(params.harness ?? ''))
      throw new ChannelError('unsupported', 'ACP authentication unavailable')
    try {
      return await host.request(method, params, {
        timeoutMs:
          method === 'litch/acp/auth/authenticate' || method === 'litch/acp/auth/continue'
            ? 150000
            : 30000,
      })
    } catch (error) {
      throw host.fail(error)
    }
  }
  return {
    read: (harness: string) => call('litch/acp/auth/read', { harness }),
    authenticate: (harness: string, methodId: string) =>
      call('litch/acp/auth/authenticate', { harness, methodId }),
    continue: (harness: string, attemptId: string, authorizationCode: string) =>
      call('litch/acp/auth/continue', { harness, attemptId, authorizationCode }),
    cancel: (harness: string, attemptId: string) =>
      call('litch/acp/auth/cancel', { harness, attemptId }),
    logout: (harness: string) => call('litch/acp/auth/logout', { harness }),
  }
}
