// Litch 自身审批的存储和手机验签留在可信桌面宿主。
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  ClientToolInvocation as SharedCall,
  ClientToolContext as SharedContext,
} from '../../../../third_party/litch-automation/packages/computer-use/src/call-types.mjs'
import { ComputerSelfGuard as SharedSelfGuard } from '../../../../third_party/litch-automation/packages/computer-use/src/self-guard.mjs'
import { approvalDesktopId, phoneAnswerLanded, verifyPhoneAnswer } from '../approvals/verify.mjs'
import type { ClientToolContext, ClientToolInvocation } from '../client-tools/types.mjs'
import { type HelperAccess, type HelperRequester, permissionMessage } from './executor.mjs'
import { HelperError, type PermissionStatus } from './wire.mjs'

export class ComputerSelfGuard extends SharedSelfGuard {
  private readonly platform: string
  private readonly scoped = new AsyncLocalStorage<{
    context: SharedContext
    approved: Set<number>
    batch: boolean
  }>()

  constructor(file?: string, now = Date.now, platform: string = process.platform) {
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
    this.platform = platform
  }

  override wrap(helper: HelperAccess): HelperAccess {
    const targetMethods = new Set([
      'getAppState',
      'click',
      'typeText',
      'pressKey',
      'scroll',
      'setValue',
      'drag',
      'selectText',
    ])
    const wrap = (client: HelperRequester): HelperRequester => ({
      ...(client.hello === undefined ? {} : { hello: client.hello }),
      request: async (method, params, timeout, signal) => {
        const scope = this.scoped.getStore()
        if (scope && targetMethods.has(method) && params && params.selfAllowed !== true) {
          const pid = params.targetPid
          if (typeof pid !== 'number')
            throw new HelperError(
              'unauthorized',
              'The helper could not verify the target application.',
            )
          if (!scope.approved.has(pid)) {
            if (scope.batch)
              throw new HelperError(
                'unauthorized',
                'The application changed after batch approval. No action was sent to the new application.',
              )
            await this.authorizeApp(client, pid, scope)
          }
          if (scope.context.signal.aborted)
            throw new HelperError('unauthorized', 'The application approval was cancelled.')
        }
        return client.request(method, params, timeout, signal)
      },
    })
    // 通用助手先解析并固定实际目标进程；宿主再检查该已解析应用的授权。
    return super.wrap({
      client: async () => wrap(await helper.client()),
      restart: () => helper.restart(),
      get connected() {
        return helper.connected ? wrap(helper.connected) : null
      },
    })
  }

  private async authorizeApp(
    client: HelperRequester,
    pid: number,
    scope: { context: SharedContext; approved: Set<number> },
  ): Promise<void> {
    const { signal } = scope.context
    const result = (await client.request('listApps', {}, 10_000, signal)) as {
      apps?: { pid: number; name: string; appId?: string; bundleId?: string | null }[]
    }
    const app = result.apps?.find((item) => item.pid === pid)
    const id = app?.appId ?? app?.bundleId
    if (!app || !id)
      throw new HelperError(
        'unauthorized',
        'The helper could not verify a stable identity for the target application.',
      )
    // 该宿主的端口另外支持应用授权；通用 CU 包只声明自身保护卡。
    const host = scope.context as ClientToolContext
    const answer = await host.ask({ kind: 'computerApp', app: `${app.name} (${id})`, pid })
    if (signal.aborted || answer !== 'once')
      throw new HelperError(
        'unauthorized',
        'The application has not been approved. Do not bypass this restriction.',
      )
    scope.approved.add(pid)
  }

  override async run<T>(
    call: SharedCall,
    context: SharedContext,
    helper: HelperAccess,
    body: () => Promise<T>,
  ): Promise<T> {
    const invocation = call as ClientToolInvocation
    if (!invocation.unattended || invocation.fullAccess)
      return super.run(call, context, helper, body)
    const scope = { context, approved: new Set<number>(), batch: call.tool === 'run_actions' }
    if (scope.batch) {
      const actions = (call.arguments as { actions?: unknown } | null)?.actions
      if (Array.isArray(actions) && actions.length) {
        const client = await helper.client()
        if (this.platform !== 'win32') {
          const status = (await client.request(
            'permissions',
            {},
            5000,
            context.signal,
          )) as PermissionStatus
          if (!status.accessibility || !status.screenRecording)
            throw new HelperError('permission', permissionMessage(status))
        }
        const targets = new Map<number, boolean>()
        for (const action of actions) {
          const arg = action?.arguments
          if (typeof arg?.app !== 'string') continue
          const { self, pid } = (await client.request(
            'inspectTarget',
            {
              app: arg.app,
              windowId: arg.window,
            },
            10_000,
            context.signal,
          )) as { self: boolean; pid: number }
          if (!Number.isSafeInteger(pid) || typeof self !== 'boolean')
            throw new HelperError(
              'unauthorized',
              'The helper could not verify the target application.',
            )
          targets.set(pid, self)
        }
        if (targets.size > 1)
          throw new HelperError(
            'invalid',
            'An unattended batch must target one application. Submit separate calls for each app.',
          )
        for (const [pid, self] of targets) if (!self) await this.authorizeApp(client, pid, scope)
      }
    }
    return this.scoped.run(scope, () => super.run(call, context, helper, body))
  }
}
