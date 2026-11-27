// Litch 自身审批的存储和手机验签留在可信桌面宿主。
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { UNATTENDED_COMPUTER_SELF } from '../../../../packages/protocol/src/client-tools.mjs'
import type {
  ClientToolInvocation as SharedCall,
  ClientToolContext as SharedContext,
} from '../../../../third_party/litch-automation/packages/computer-use/src/call-types.mjs'
import { ComputerSelfGuard as SharedSelfGuard } from '../../../../third_party/litch-automation/packages/computer-use/src/self-guard.mjs'
import { approvalDesktopId, phoneAnswerLanded, verifyPhoneAnswer } from '../approvals/verify.mjs'
import type { ClientToolInvocation } from '../client-tools/types.mjs'
import type { HelperAccess, HelperRequester } from './executor.mjs'
import { HelperError } from './wire.mjs'

export class ComputerSelfGuard extends SharedSelfGuard {
  private readonly unattended = new AsyncLocalStorage<true>()

  constructor(file?: string, now = Date.now) {
    super({
      productName: 'Litch',
      now,
      remote: {
        desktopId: approvalDesktopId,
        verify: verifyPhoneAnswer,
        landed: phoneAnswerLanded,
      },
      ...(file
        ? {
            storage: {
              read: () =>
                (JSON.parse(readFileSync(file, 'utf8')) as { expiresAt: number | null }).expiresAt,
              write: (expiresAt: number | null) => {
                mkdirSync(dirname(file), { recursive: true })
                writeFileSync(`${file}.tmp`, JSON.stringify({ expiresAt }), { mode: 0o600 })
                renameSync(`${file}.tmp`, file)
              },
            },
          }
        : {}),
    })
  }

  override wrap(helper: HelperAccess): HelperAccess {
    return super.wrap(this.guardTargets(helper))
  }

  private guardTargets(helper: HelperAccess): HelperAccess {
    const wrap = (client: HelperRequester): HelperRequester => ({
      ...(client.hello === undefined ? {} : { hello: client.hello }),
      request: async (method, params, timeout, signal) => {
        const result = await client.request(method, params, timeout, signal)
        // 在通用防护检查已有授权和批次发出首个动作之前拦下自身。
        if (
          method === 'inspectTarget' &&
          this.unattended.getStore() &&
          (result as { self?: boolean } | null)?.self === true
        )
          throw new HelperError('unauthorized', UNATTENDED_COMPUTER_SELF)
        return result
      },
    })
    return {
      client: async () => wrap(await helper.client()),
      restart: () => helper.restart(),
      get connected() {
        return helper.connected ? wrap(helper.connected) : null
      },
    }
  }

  override async run<T>(
    call: SharedCall,
    context: SharedContext,
    helper: HelperAccess,
    body: () => Promise<T>,
  ): Promise<T> {
    if (!(call as ClientToolInvocation).unattended) return super.run(call, context, helper, body)
    // 批次预检直接使用传给 run 的助手；单步经 wrap，两个入口都检查实际目标。
    return this.unattended.run(true, () =>
      super.run(call, context, this.guardTargets(helper), body),
    )
  }
}
