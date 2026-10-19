// 替原生 codex 答 harness 详情设置（litch/harness/*）：它不认识这些方法，设备进程翻译成它自己的
// config/*、account/*、mcpServer/*、skills/*、memory/* 再把结果整理成约定的形状。各部分在：
// 配置项 codex-settings*.mts，provider 与账号 codex-providers*.mts，MCP codex-mcp.mts，读写配置的底层 codex-config-io.mts。
// 指令文件是 $CODEX_HOME/AGENTS.md，设备进程和 codex 在同一台机器上，直接读写（要看它是不是软链，codex 的 fs/* 给不了）；
// 同一目录下的 AGENTS.override.md 不是空的时 codex 读它不读 AGENTS.md（上游 project_doc），报在 overriddenBy 里。
//
// 一个翻译器属于一条客户端连接：登录（ChatGPT、MCP 的 OAuth）从哪条连接开的，进展（auth/updated）就只告诉那条；
// 成了以后 config/changed 告诉所有声明过 harnessConfig 的连接。
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HARNESS_CONFIG_NOTIFICATION,
  type HarnessAuthStartResponse,
  type HarnessAuthStep,
  type HarnessAuthUpdatedNotification,
  HARNESS_CONFIG_METHOD as M,
} from '../../protocol/src/harness-config.mjs'
import type { Ask } from './codex-config-io.mjs'
import { readCodexMcp, removeCodexMcp, upsertCodexMcp } from './codex-mcp.mjs'
import { METHOD, OPENAI, openaiAuth, readCodexProviders } from './codex-providers.mjs'
import {
  activateCodexProvider,
  removeCodexProvider,
  upsertCodexProvider,
} from './codex-providers-write.mjs'
import { readCodexSettings } from './codex-settings.mjs'
import { runCodexAction, writeCodexSettings } from './codex-settings-write.mjs'
import {
  HarnessConfigError,
  type HarnessConfigTranslator,
  type TranslatorContext,
  text,
} from './harness-config.mjs'
import { readInstructions, writeInstructions } from './instructions.mjs'
import { isObject } from './wire.mjs'

type Attempt =
  | { kind: 'account'; loginId: string; providerId: string }
  | { kind: 'mcp'; server: string }

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * 授权完回调到设备上的哪个端口：授权链接里 redirect_uri 指着回环地址时就是它的端口（codex 的登录服务，
 * ChatGPT 登录实测是 1455；MCP 的看 mcp_oauth_callback_port，不配是随机的）。不是回环的回调（托管的回调页）是 null
 */
export function callbackPort(url: string): number | null {
  try {
    const redirect = new URL(url).searchParams.get('redirect_uri')
    if (!redirect) return null
    const target = new URL(redirect)
    if (!LOOPBACK.has(target.hostname)) return null
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

export class CodexHarnessConfig implements HarnessConfigTranslator {
  private readonly context: TranslatorContext
  private readonly ask: Ask
  private readonly attempts = new Map<string, Attempt>()

  constructor(context: TranslatorContext) {
    this.context = context
    this.ask = context.ask
  }

  private get harness(): string {
    return this.context.harness
  }

  private home(): string {
    const home = this.context.home()
    if (home) return home
    throw new HarnessConfigError(
      'unavailable',
      this.harness,
      text('codex 握手时没有报它的数据目录', 'codex did not report its home directory'),
    )
  }

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const { ask, harness } = this
    switch (method) {
      case M.configRead:
        return (await readCodexSettings(ask, harness, this.context.home())).response
      case M.configWrite:
        return this.changing(
          'config',
          writeCodexSettings(ask, harness, this.context.home(), params),
        )
      case M.configAction:
        return this.changing('config', runCodexAction(ask, harness, params))
      case M.providersRead:
        return readCodexProviders(ask, harness, this.context.envNames(), this.context.home())
      case M.providersUpsert:
        return this.changing('providers', upsertCodexProvider(ask, harness, params))
      case M.providersRemove:
        return this.changing('providers', removeCodexProvider(ask, harness, params))
      case M.providersActivate:
        return this.changing('providers', activateCodexProvider(ask, harness, params))
      case M.authStart:
        return this.authStart(params)
      case M.authContinue:
        return this.authContinue(params)
      case M.authCancel:
        return this.authCancel(params)
      case M.authLogout:
        return this.authLogout(params)
      case M.mcpRead:
        return readCodexMcp(ask, harness)
      case M.mcpUpsert:
        return this.changing('mcp', upsertCodexMcp(ask, harness, params))
      case M.mcpRemove:
        return this.changing('mcp', removeCodexMcp(ask, harness, params))
      case M.mcpLogin:
        return this.mcpLogin(params)
      case M.instructionsRead:
        return this.instructionsRead()
      case M.instructionsWrite:
        return this.changing(
          'instructions',
          writeInstructions(
            harness,
            join(this.home(), 'AGENTS.md'),
            params.content as string,
            params.expectedHash,
          ),
        )
      default:
        throw new HarnessConfigError(
          'notFound',
          harness,
          text(`设备进程没有替 codex 实现 ${method}`, `${method} is not available for codex`),
        )
    }
  }

  /** 写成了就告诉各条连接这一块变了 */
  private async changing<T>(
    part: 'config' | 'providers' | 'mcp' | 'instructions',
    work: Promise<T>,
  ): Promise<T> {
    const result = await work
    this.context.changed(part)
    return result
  }

  private async instructionsRead() {
    const home = this.home()
    const override = join(home, 'AGENTS.override.md')
    const text = await readFile(override, 'utf8').catch(() => '')
    return readInstructions(join(home, 'AGENTS.md'), text.trim() ? override : null)
  }

  private invalid(zh: string, en: string): HarnessConfigError {
    return new HarnessConfigError('invalidValue', this.harness, text(zh, en))
  }

  private async authStart(params: Record<string, unknown>): Promise<HarnessAuthStartResponse> {
    const providerId = params.providerId
    if (providerId !== OPENAI) {
      const providers = await readCodexProviders(
        this.ask,
        this.harness,
        this.context.envNames(),
        this.context.home(),
      )
      const provider = providers.providers.find((item) => item.id === providerId)
      if (!provider)
        throw new HarnessConfigError(
          'notFound',
          this.harness,
          text(`没有这个 provider：${String(providerId)}`, 'No such provider'),
        )
      if (provider.methods.some((item) => item.id === params.methodId && item.kind === 'env'))
        throw this.invalid(
          '环境变量方式不经 auth/start：把 key 写进设备设置的 harness.codex.env，再重启 Codex',
          'Environment-variable keys are set through device settings, not auth/start',
        )
      throw new HarnessConfigError(
        'notFound',
        this.harness,
        text(`${String(providerId)} 没有这种登录方式`, 'No such sign-in method'),
      )
    }
    switch (params.methodId) {
      case METHOD.chatgpt: {
        const result = await this.ask('account/login/start', { type: 'chatgpt' })
        const fields = isObject(result) ? result : {}
        const loginId = String(fields.loginId)
        const url = String(fields.authUrl)
        this.attempts.set(loginId, { kind: 'account', loginId, providerId: OPENAI })
        return {
          attemptId: loginId,
          step: {
            kind: 'openUrl',
            url,
            callbackPort: callbackPort(url),
            message: text(
              '在浏览器里登录 ChatGPT，授权完会回到设备上的 codex',
              'Sign in to ChatGPT in the browser',
            ),
          },
        }
      }
      case METHOD.deviceCode: {
        const result = await this.ask('account/login/start', { type: 'chatgptDeviceCode' })
        const fields = isObject(result) ? result : {}
        const loginId = String(fields.loginId)
        this.attempts.set(loginId, { kind: 'account', loginId, providerId: OPENAI })
        return {
          attemptId: loginId,
          step: {
            kind: 'deviceCode',
            url: String(fields.verificationUrl),
            userCode: String(fields.userCode),
            message: text(
              '打开网址、登录 ChatGPT 后输入这个码',
              'Open the link, sign in and enter the code',
            ),
          },
        }
      }
      case METHOD.apiKey: {
        const inputs = isObject(params.inputs) ? params.inputs : {}
        const apiKey = typeof inputs.apiKey === 'string' ? inputs.apiKey.trim() : ''
        if (!apiKey) throw this.invalid('要填 API key', 'An API key is required')
        await this.ask('account/login/start', { type: 'apiKey', apiKey })
        const auth = await openaiAuth(this.ask, this.context.home())
        this.context.changed('providers')
        return { attemptId: randomUUID(), step: { kind: 'done', auth } }
      }
      default:
        throw new HarnessConfigError(
          'notFound',
          this.harness,
          text(`没有这种登录方式：${String(params.methodId)}`, 'No such sign-in method'),
        )
    }
  }

  private attempt(params: Record<string, unknown>): [string, Attempt] {
    const id = params.attemptId
    const attempt = typeof id === 'string' ? this.attempts.get(id) : undefined
    if (typeof id === 'string' && attempt) return [id, attempt]
    throw new HarnessConfigError(
      'notFound',
      this.harness,
      text('没有这次登录，可能已经结束了', 'No such sign-in attempt'),
    )
  }

  private authContinue(params: Record<string, unknown>): never {
    this.attempt(params)
    throw this.invalid('这次登录不用再交东西，等它完成就好', 'This sign-in needs no further input')
  }

  private async authCancel(params: Record<string, unknown>): Promise<Record<string, never>> {
    const [id, attempt] = this.attempt(params)
    this.attempts.delete(id)
    // MCP 的 OAuth 在 codex 里没有取消的方法，到点它自己收掉
    if (attempt.kind === 'account')
      await this.ask('account/login/cancel', { loginId: attempt.loginId }).catch(() => null)
    return {}
  }

  private async authLogout(params: Record<string, unknown>): Promise<Record<string, never>> {
    if (params.providerId !== OPENAI)
      throw this.invalid(
        '只有 OpenAI 有登录可以登出；自定义 provider 的 key 在设备设置里清掉',
        'Only OpenAI has a sign-in to log out of',
      )
    await this.ask('account/logout', {})
    this.context.changed('providers')
    return {}
  }

  private async mcpLogin(params: Record<string, unknown>): Promise<HarnessAuthStartResponse> {
    if (typeof params.name !== 'string' || !params.name)
      throw this.invalid('缺少 name', 'name is required')
    const result = await this.ask('mcpServer/oauth/login', { name: params.name })
    const url = isObject(result) ? String(result.authorizationUrl) : ''
    const attemptId = randomUUID()
    this.attempts.set(attemptId, { kind: 'mcp', server: params.name })
    return {
      attemptId,
      step: {
        kind: 'openUrl',
        url,
        callbackPort: callbackPort(url),
        message: text(
          `在浏览器里授权 MCP 服务 ${params.name}`,
          `Authorize the MCP server ${params.name} in the browser`,
        ),
      },
    }
  }

  private report(attemptId: string, attempt: Attempt, step: HarnessAuthStep): void {
    const params: HarnessAuthUpdatedNotification = {
      harness: this.harness,
      attemptId,
      ...(attempt.kind === 'account'
        ? { providerId: attempt.providerId }
        : { mcpServer: attempt.server }),
      step,
    }
    this.context.notify(HARNESS_CONFIG_NOTIFICATION.authUpdated, params)
  }

  /** codex 说一次登录有了结果：是这条连接开的就报进展 */
  notification(method: string, params: Record<string, unknown>): void {
    if (method === 'account/login/completed' && typeof params.loginId === 'string') {
      const attempt = this.attempts.get(params.loginId)
      if (!attempt) return
      this.attempts.delete(params.loginId)
      const loginId = params.loginId
      if (params.success !== true) {
        const reason = typeof params.error === 'string' ? params.error : ''
        this.report(loginId, attempt, {
          kind: 'failed',
          message: text(`登录没有成功：${reason}`, `Sign-in failed: ${reason}`),
        })
        return
      }
      void openaiAuth(this.ask, this.context.home()).then((auth) => {
        this.report(loginId, attempt, { kind: 'done', auth })
        this.context.changed('providers')
      })
      return
    }
    if (method === 'mcpServer/oauthLogin/completed' && typeof params.name === 'string') {
      const found = [...this.attempts].find(
        ([, item]) => item.kind === 'mcp' && item.server === params.name,
      )
      if (!found) return
      const [attemptId, attempt] = found
      this.attempts.delete(attemptId)
      const step: HarnessAuthStep =
        params.success === true
          ? { kind: 'done', auth: { signedIn: true, kind: 'oauth', label: null } }
          : {
              kind: 'failed',
              message: text(
                `授权没有成功：${String(params.error ?? '')}`,
                `Authorization failed: ${String(params.error ?? '')}`,
              ),
            }
      this.report(attemptId, attempt, step)
      if (params.success === true) this.context.changed('mcp')
    }
  }

  close(): void {
    this.attempts.clear()
  }
}
