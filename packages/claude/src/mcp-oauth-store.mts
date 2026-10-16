import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  type OAuthClientInformationMixed,
  OAuthClientInformationSchema,
  type OAuthTokens,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { submissionHash } from './protocol-contract.mjs'

export interface OAuthBinding {
  source: string
  name: string
  url: string
  configuration: string
}
export interface OAuthCredential {
  version: 1
  binding: OAuthBinding
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  expiresAt?: number
  discovery?: OAuthDiscoveryState
  redirectUrl?: string
}

export function oauthBinding(
  source: string,
  name: string,
  config: Record<string, unknown>,
): OAuthBinding {
  return {
    source,
    name,
    url: new URL(String(config.url)).href,
    configuration: submissionHash(config),
  }
}

// 文件只属于当前适配器 HOME，凭据不会进入会话历史、配置协议或模型上下文。
export class OAuthCredentialStore {
  readonly directory: string

  constructor(home: string) {
    this.directory = join(home, 'mcp-oauth')
  }

  key(binding: OAuthBinding): string {
    return createHash('sha256').update(JSON.stringify(binding)).digest('hex')
  }

  read(binding: OAuthBinding): OAuthCredential {
    let text: string
    try {
      // O_NOFOLLOW 只保护最终文件；目录链接也必须拒绝，避免跨 HOME 读取 token。
      const directory = lstatSync(this.directory)
      if (!directory.isDirectory() || directory.isSymbolicLink())
        throw new Error('MCP OAuth 凭据目录无效')
      const fd = openSync(
        join(this.directory, this.key(binding) + '.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
      try {
        text = readFileSync(fd, 'utf8')
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, binding }
      throw new Error('无法读取 MCP OAuth 凭据')
    }
    try {
      const value = JSON.parse(text) as OAuthCredential
      if (value.version !== 1 || JSON.stringify(value.binding) !== JSON.stringify(binding))
        throw new Error()
      if (value.client && !OAuthClientInformationSchema.safeParse(value.client).success)
        throw new Error()
      if (value.tokens && !OAuthTokensSchema.safeParse(value.tokens).success) throw new Error()
      if (
        value.expiresAt !== undefined &&
        (!Number.isFinite(value.expiresAt) || value.expiresAt < 0)
      )
        throw new Error()
      return value
    } catch {
      throw new Error('MCP OAuth 凭据格式或绑定无效')
    }
  }

  write(value: OAuthCredential): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    if (!lstatSync(this.directory).isDirectory() || lstatSync(this.directory).isSymbolicLink())
      throw new Error('MCP OAuth 凭据目录无效')
    chmodSync(this.directory, 0o700)
    const target = join(this.directory, this.key(value.binding) + '.json')
    const temporary = target + '.' + randomUUID() + '.tmp'
    let fd: number | undefined
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify(value) + String.fromCharCode(10))
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temporary, target)
      const directory = openSync(this.directory, 'r')
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
    } finally {
      if (fd !== undefined) closeSync(fd)
      rmSync(temporary, { force: true })
    }
  }
}
