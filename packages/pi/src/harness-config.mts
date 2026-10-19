// harness 详情设置（harnessConfig 扩展）的 Pi 实现：litch/harness/* 的入口，以及用户级指令文件。
// 权威在 Pi 自己的文件里（<agent-dir>/settings.json、models.json、mcp.json、auth.json、AGENTS.md），
// 和设备上的 pi 命令行共用；这里只是按协议的形状读写它们。配置项在 harness-settings.mts，
// provider 与登录在 harness-providers.mts，MCP 在 harness-mcp.mts。
import { lstat, mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import {
  HARNESS_CONFIG_METHOD,
  type HarnessInstructionsInfo,
  type HarnessInstructionsWriteParams,
} from '../../protocol/src/harness-config.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { agentPath, changed, checkVersion, fail, hashOf, readText } from './harness-common.mjs'
import { mcpLogin, mcpRead, mcpRemove, mcpUpsert } from './harness-mcp.mjs'
import {
  authCancel,
  authContinue,
  authLogout,
  authStart,
  providersActivate,
  providersRead,
  providersRemove,
  providersUpsert,
} from './harness-providers.mjs'
import { configRead, configWrite } from './harness-settings.mjs'
import { InternalsUnavailable } from './pi-internals.mjs'
import { getAgentDir } from './sdk.mjs'
import type { PiServer } from './server.mjs'

export async function harnessConfigRequest(
  s: PiServer,
  _peer: RpcPeer,
  method: string,
  p: any,
): Promise<any> {
  try {
    switch (method) {
      case HARNESS_CONFIG_METHOD.configRead:
        return await configRead()
      case HARNESS_CONFIG_METHOD.configWrite:
        return await configWrite(s, p)
      case HARNESS_CONFIG_METHOD.configAction:
        // Pi 没有要单独执行的动作（config/read 的 actions 是空的）
        return fail('notFound', `没有动作 ${p.actionId}`, `No action ${p.actionId}`)
      case HARNESS_CONFIG_METHOD.providersRead:
        return await providersRead()
      case HARNESS_CONFIG_METHOD.providersUpsert:
        return await providersUpsert(s, p)
      case HARNESS_CONFIG_METHOD.providersRemove:
        return await providersRemove(s, p)
      case HARNESS_CONFIG_METHOD.providersActivate:
        return await providersActivate(s, p)
      case HARNESS_CONFIG_METHOD.authStart:
        return await authStart(s, p)
      case HARNESS_CONFIG_METHOD.authContinue:
        return await authContinue(p)
      case HARNESS_CONFIG_METHOD.authCancel:
        return authCancel(p)
      case HARNESS_CONFIG_METHOD.authLogout:
        return await authLogout(s, p)
      case HARNESS_CONFIG_METHOD.mcpRead:
        return await mcpRead()
      case HARNESS_CONFIG_METHOD.mcpUpsert:
        return await mcpUpsert(s, p)
      case HARNESS_CONFIG_METHOD.mcpRemove:
        return await mcpRemove(s, p)
      case HARNESS_CONFIG_METHOD.mcpLogin:
        return await mcpLogin(s, p)
      case HARNESS_CONFIG_METHOD.instructionsRead:
        return await instructionsRead()
      case HARNESS_CONFIG_METHOD.instructionsWrite:
        return await instructionsWrite(s, p)
      default:
        throw new ProtocolError(-32601, `Pi 不支持 ${method}`)
    }
  } catch (error) {
    if (error instanceof InternalsUnavailable) fail('unavailable', error.message, error.message)
    throw error
  }
}

// ---------- 指令文件 ----------

// Pi 在代理目录里按 AGENTS.override.md、AGENTS.md、AGENTS.MD、CLAUDE.md、CLAUDE.MD 的次序取第一份存在的
// （resource-loader 的 loadContextFileFromDir）。我们编辑的是 AGENTS.md；override 那份在就盖住它。
const instructionsPath = () => agentPath('AGENTS.md')

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function instructionsRead(): Promise<HarnessInstructionsInfo> {
  const path = instructionsPath()
  const content = await readText(path)
  const link = await lstat(path).catch(() => undefined)
  const override = agentPath('AGENTS.override.md')
  return {
    path,
    fileName: 'AGENTS.md',
    exists: content !== undefined,
    content: content ?? '',
    hash: hashOf(content),
    linkTarget: link?.isSymbolicLink() ? await realpath(path).catch(() => null) : null,
    overriddenBy: (await isFile(override)) ? override : null,
  }
}

async function instructionsWrite(
  s: PiServer,
  p: HarnessInstructionsWriteParams,
): Promise<{ hash: string }> {
  if (typeof p.content !== 'string')
    fail('invalidValue', 'content 必须是字符串', 'content must be a string', 'content')
  const path = instructionsPath()
  checkVersion(p.expectedHash, hashOf(await readText(path)))
  // 统一模式下这里是软链：照着写进它指向的那份，软链不动
  await mkdir(getAgentDir(), { recursive: true })
  await writeFile(path, p.content, 'utf8')
  changed(s, 'instructions')
  return { hash: hashOf(p.content) }
}
