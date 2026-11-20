// 桌面端只解析自己的 gh 登录；设备来源凭据不会经过这个桥。
import { execFile } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ExternalOwnerIdentity,
  type ExternalOwnerInput,
  type GlobalExternalOwner,
  githubNumericId,
  githubProfileLogin,
  isExternalOwnerIdentity,
} from '@litch/core'

type GitHubReply = { id?: unknown; login?: unknown; type?: unknown }
type AccountDependencies = {
  env?(): Promise<NodeJS.ProcessEnv> | NodeJS.ProcessEnv
  fetch?: typeof fetch
}

function publicIdentity(text: string, method: ExternalOwnerInput['method']): ExternalOwnerIdentity {
  const value: GitHubReply = JSON.parse(text, (key, val, context?: { source?: string }) =>
    key === 'id' && typeof val === 'number'
      ? (context?.source ?? (Number.isSafeInteger(val) ? String(val) : null))
      : val,
  )
  if (value.type !== 'User' || typeof value.login !== 'string' || typeof value.id !== 'string')
    throw new Error('not-user')
  const owner: ExternalOwnerIdentity = {
    provider: 'github',
    userId: value.id,
    loginCache: value.login,
    profileUrl: `https://github.com/${value.login}`,
    method,
  }
  if (!isExternalOwnerIdentity(owner)) throw new Error('invalid-user')
  return owner
}

function ghUser(env: NodeJS.ProcessEnv): Promise<string> {
  // GH_TOKEN/GITHUB_TOKEN 优先于本机登录，GH_DEBUG 会打印请求；二者均不继承。
  const safe: NodeJS.ProcessEnv = {}
  for (const key of [
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CONFIG_HOME',
    'GH_CONFIG_DIR',
    'SystemRoot',
    'SSH_AUTH_SOCK',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
  ])
    if (env[key] !== undefined) safe[key] = env[key]
  safe.GH_PROMPT_DISABLED = '1'
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['api', 'user', '--hostname', 'github.com'],
      {
        env: safe,
        timeout: 8000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(new Error('gh-unavailable'))
        else resolve(stdout)
      },
    )
  })
}

export function createExternalAccount(dataDir: string, deps: AccountDependencies = {}) {
  const file = join(dataDir, 'external-owner.json')
  const get = (): GlobalExternalOwner | null => {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as GlobalExternalOwner
      return data &&
        isExternalOwnerIdentity(data.owner) &&
        Number.isSafeInteger(data.revision) &&
        data.revision > 0
        ? data
        : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  return {
    get,
    save(owner: ExternalOwnerIdentity, expectedRevision: number): boolean {
      if (!isExternalOwnerIdentity(owner) || (get()?.revision ?? 0) !== expectedRevision)
        return false
      const selected: ExternalOwnerIdentity = {
        provider: 'github',
        userId: owner.userId,
        loginCache: owner.loginCache,
        profileUrl: owner.profileUrl,
        method: owner.method,
      }
      const temp = `${file}.next`
      writeFileSync(temp, JSON.stringify({ owner: selected, revision: expectedRevision + 1 }), {
        mode: 0o600,
      })
      renameSync(temp, file)
      return true
    },
    async avatar(userId: string): Promise<string | null> {
      if (typeof userId !== 'string' || !githubNumericId(userId)) return null
      const response = await (deps.fetch ?? fetch)(
        `https://avatars.githubusercontent.com/u/${userId}?s=96`,
        {
          redirect: 'error',
          signal: AbortSignal.timeout(4000),
          credentials: 'omit',
        },
      )
      const type = response.headers.get('content-type')?.split(';')[0]
      if (
        !response.ok ||
        !response.body ||
        !type ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(type)
      )
        return null
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          length += chunk.value.byteLength
          if (length > 128 * 1024) return null
          chunks.push(chunk.value)
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      return length ? `data:${type};base64,${Buffer.concat(chunks).toString('base64')}` : null
    },
    async resolve(input: ExternalOwnerInput): Promise<ExternalOwnerIdentity> {
      if (input.method === 'localGh')
        return publicIdentity(await ghUser(await (deps.env?.() ?? process.env)), input.method)
      const raw = input.value?.trim()
      const key =
        input.method === 'userId' ? (githubNumericId(raw) ? raw : null) : githubProfileLogin(raw)
      if (!key) throw new Error('invalid-input')
      const path = input.method === 'userId' ? 'user' : 'users'
      const response = await (deps.fetch ?? fetch)(`https://api.github.com/${path}/${key}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Litch' },
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) throw new Error('github-unavailable')
      const result = publicIdentity(await response.text(), input.method)
      if (input.method === 'userId' && result.userId !== key) throw new Error('id-mismatch')
      return result
    },
  }
}

export type ExternalAccount = ReturnType<typeof createExternalAccount>
