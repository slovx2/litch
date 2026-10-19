// harness 详情设置（harnessConfig 扩展，类型在 packages/protocol/src/harness-config.mts）在 dsh 入口上的接法。
// 配置项见 harness-settings.mts，provider 与登录见 harness-providers.mts，MCP 见 harness-mcp.mts；
// 指令文件是 $DSH_HOME/AGENTS.md（dsh 的 agent-instructions 读的用户级那一份），这里直接读写。
// 改了什么就给声明过扩展的连接发 litch/harness/config/changed；登录的进展发 litch/harness/auth/updated。

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  HARNESS_CONFIG_NOTIFICATION,
  type HarnessAuthStep,
  type HarnessConfigChangedNotification,
  type HarnessInstructionsInfo,
  HARNESS_CONFIG_METHOD as M,
} from '../../protocol/src/harness-config.mjs'
import { fromRemote, HARNESS_ID, HarnessConfigError, text } from './harness-common.mjs'
import { readMcp, removeMcp, upsertMcp } from './harness-mcp.mjs'
import {
  ACCOUNT,
  activateProvider,
  logout,
  newAttemptId,
  readProviders,
  removeProvider,
  setApiKey,
  startAccountSignIn,
  upsertProvider,
} from './harness-providers.mjs'
import { readConfig, writeConfig } from './harness-settings.mjs'
import type { WebRemote } from './remote.mjs'
import { dshHome } from './runtime.mjs'

export interface HarnessConfigHost {
  remote(): Promise<WebRemote>
  notifyConfig(method: string, params: unknown): void
}

const hashOf = (content: string): string => createHash('sha256').update(content).digest('hex')

export const instructionsPath = (): string => join(dshHome(), 'AGENTS.md')

function readInstructions(): HarnessInstructionsInfo {
  const path = instructionsPath()
  let content: string | null = null
  try {
    content = readFileSync(path, 'utf8')
  } catch {}
  let linkTarget: string | null = null
  try {
    // 照软链里写的、按它所在的目录解析，不再往下解析一层：和统一模式给的 sourcePath 对得上
    if (lstatSync(path).isSymbolicLink()) linkTarget = resolve(dirname(path), readlinkSync(path))
  } catch {}
  return {
    path,
    fileName: 'AGENTS.md',
    exists: content !== null,
    content: content ?? '',
    hash: content === null ? '' : hashOf(content),
    linkTarget,
    overriddenBy: null,
  }
}

export class DshHarnessConfig {
  private readonly host: HarnessConfigHost
  // 进行中的 DeepSeek 账号登录：attemptId → 停止跟随
  private readonly logins = new Map<string, () => void>()

  constructor(host: HarnessConfigHost) {
    this.host = host
  }

  private changed(part: HarnessConfigChangedNotification['part']): void {
    const params: HarnessConfigChangedNotification = { harness: HARNESS_ID, part }
    this.host.notifyConfig(HARNESS_CONFIG_NOTIFICATION.changed, params)
  }

  private async remote(): Promise<WebRemote> {
    try {
      return await this.host.remote()
    } catch (error) {
      throw fromRemote(error)
    }
  }

  async handle(method: string, p: any): Promise<unknown> {
    switch (method) {
      case M.configRead:
        return readConfig(await this.remote())
      case M.configWrite: {
        if (!Array.isArray(p.edits)) throw invalidParams('edits')
        const result = await writeConfig(
          await this.remote(),
          p.edits,
          String(p.expectedVersion ?? ''),
        )
        this.changed('config')
        return result
      }
      case M.configAction:
        throw new HarnessConfigError(
          'notFound',
          text(`dsh 没有 ${p.actionId} 这个动作`, `dsh has no action ${p.actionId}`),
        )
      case M.providersRead:
        return readProviders(await this.remote())
      case M.providersUpsert: {
        const result = await upsertProvider(
          await this.remote(),
          String(p.providerId ?? ''),
          String(p.templateId ?? ''),
          p.definition ?? {},
          String(p.expectedVersion ?? ''),
        )
        this.changed('providers')
        return result
      }
      case M.providersRemove: {
        const result = await removeProvider(await this.remote(), String(p.providerId ?? ''))
        this.changed('providers')
        return result
      }
      case M.providersActivate: {
        const result = await activateProvider(
          await this.remote(),
          String(p.providerId ?? ''),
          String(p.expectedVersion ?? ''),
        )
        this.changed('providers')
        return result
      }
      case M.authStart:
        return this.authStart(String(p.providerId ?? ''), String(p.methodId ?? ''), p.inputs ?? {})
      case M.authContinue:
        throw new HarnessConfigError(
          'notFound',
          text('dsh 的登录没有要再填的一步', 'dsh sign-in has no step that takes input'),
        )
      case M.authCancel: {
        const remote = await this.remote()
        await remote
          .rpc('account/cancelSignIn', { attemptId: String(p.attemptId ?? '') })
          .catch((error) => {
            throw fromRemote(error)
          })
        this.logins.get(p.attemptId)?.()
        this.logins.delete(p.attemptId)
        return {}
      }
      case M.authLogout:
        await logout(await this.remote(), String(p.providerId ?? ''))
        this.changed('providers')
        return {}
      case M.mcpRead: {
        const remote = await this.remote()
        const plugins = await remote.rpc('pluginManager/listPlugins', {}).catch(() => [])
        return readMcp(Array.isArray(plugins) ? plugins : [])
      }
      case M.mcpUpsert: {
        // 先把 dsh 拉起来：profile 目录由它建
        await this.remote()
        if (!p.server || typeof p.server !== 'object') throw invalidParams('server')
        const result = upsertMcp(
          p.previousName ?? undefined,
          p.server,
          String(p.expectedVersion ?? ''),
        )
        this.changed('mcp')
        return result
      }
      case M.mcpRemove: {
        await this.remote()
        const result = removeMcp(String(p.name ?? ''), String(p.expectedVersion ?? ''))
        this.changed('mcp')
        return result
      }
      case M.mcpLogin:
        throw new HarnessConfigError(
          'notFound',
          text('dsh 的 MCP 没有 OAuth 登录', 'dsh MCP servers have no OAuth sign-in'),
        )
      case M.instructionsRead:
        return readInstructions()
      case M.instructionsWrite: {
        if (typeof p.content !== 'string') throw invalidParams('content')
        const current = readInstructions()
        if (current.hash !== String(p.expectedHash ?? ''))
          throw new HarnessConfigError(
            'versionConflict',
            text(
              'AGENTS.md 在读过之后被改了，请重读',
              'AGENTS.md changed since it was read; reload',
            ),
          )
        // 直接写：是软链（统一模式）时写进它指向的那一份。dsh 还没在这台机器上跑过时目录可能还没有
        mkdirSync(dshHome(), { recursive: true })
        writeFileSync(current.path, p.content)
        this.changed('instructions')
        return { hash: hashOf(p.content) }
      }
      default:
        throw new HarnessConfigError(
          'notFound',
          text(`dsh 入口不认识 ${method}`, `The dsh entry does not handle ${method}`),
        )
    }
  }

  private async authStart(providerId: string, methodId: string, inputs: Record<string, string>) {
    const remote = await this.remote()
    if (providerId === ACCOUNT) {
      if (methodId !== 'browser')
        throw new HarnessConfigError(
          'notFound',
          text(`没有 ${methodId} 这种登录方式`, `No sign-in method ${methodId}`),
        )
      const notify = (attemptId: string, step: HarnessAuthStep) => {
        this.host.notifyConfig(HARNESS_CONFIG_NOTIFICATION.authUpdated, {
          harness: HARNESS_ID,
          attemptId,
          providerId,
          step,
        })
        if (step.kind === 'done' || step.kind === 'failed') this.logins.delete(attemptId)
        if (step.kind === 'done') this.changed('providers')
      }
      const { response, stop } = await startAccountSignIn(remote, notify)
      if (response.step.kind !== 'failed' && response.step.kind !== 'done')
        this.logins.set(response.attemptId, stop)
      return response
    }
    if (methodId !== 'apiKey')
      throw new HarnessConfigError(
        'notFound',
        text(`没有 ${methodId} 这种登录方式`, `No sign-in method ${methodId}`),
      )
    const auth = await setApiKey(remote, providerId, String(inputs.apiKey ?? ''))
    this.changed('providers')
    return { attemptId: newAttemptId(), step: { kind: 'done', auth } }
  }

  close(): void {
    for (const stop of this.logins.values()) stop()
    this.logins.clear()
  }
}

const invalidParams = (name: string) =>
  new HarnessConfigError(
    'invalidValue',
    text(`缺少参数 ${name}`, `Missing parameter ${name}`),
    name,
  )
