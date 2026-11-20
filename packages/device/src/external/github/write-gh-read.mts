// gh 使用已验证的绝对路径。把 HTTPS 限在固定 API 主机，即使 gh 自动跟随重定向也不会对外发送认证。
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Duplex } from 'node:stream'
import {
  GITHUB_WRITE_API_VERSION,
  GithubWriteFault,
  isManagedGithubToken,
  object,
  parseExternalGithubJson,
} from './write-api.mjs'

export function githubGhConnectAllowed(authority: string | undefined): boolean {
  return authority === 'api.github.com:443'
}

export async function withIsolatedGithubGh<T>(
  input: {
    ghPath: string
    token: string
    beforeRead: () => void
  },
  run: (get: (path: string) => Promise<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  if (!isAbsolute(input.ghPath) || !isManagedGithubToken(input.token))
    throw new GithubWriteFault('github_gh_unavailable')
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'litch-external-gh-')))
  const sockets = new Set<Duplex>()
  const remember = (socket: Duplex): void => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  }
  const proxy = createServer((_req, res) => res.writeHead(403).end())
  proxy.on('connection', remember)
  proxy.on('connect', (request, socket, head) => {
    if (!githubGhConnectAllowed(request.url) || sockets.size > 12) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const upstream = connect(443, 'api.github.com')
    remember(upstream)
    socket.on('error', () => upstream.destroy())
    socket.once('close', () => upstream.destroy())
    upstream.setTimeout(20_000, () => upstream.destroy())
    upstream.once('error', () => socket.destroy())
    upstream.once('close', () => socket.destroy())
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject)
      proxy.listen(0, '127.0.0.1', resolve)
    })
    const address = proxy.address()
    if (!address || typeof address === 'string') throw new GithubWriteFault('github_gh_unavailable')
    const env: NodeJS.ProcessEnv = {
      GH_TOKEN: input.token,
      GH_HOST: 'github.com',
      GH_CONFIG_DIR: dir,
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      HTTPS_PROXY: `http://127.0.0.1:${address.port}`,
      HOME: dir,
      USERPROFILE: dir,
      APPDATA: dir,
      XDG_CONFIG_HOME: dir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      NO_COLOR: '1',
      ...(process.platform === 'win32' && process.env.SystemRoot
        ? { SystemRoot: process.env.SystemRoot }
        : {}),
    }
    return await run(async (path) => {
      if (!/^\/(?!\/)[a-z\d_./%-]+$/i.test(path))
        throw new GithubWriteFault('github_gh_read_path_invalid')
      input.beforeRead()
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          input.ghPath,
          [
            'api',
            '--hostname',
            'github.com',
            '--method',
            'GET',
            '--header',
            'Accept: application/vnd.github+json',
            '--header',
            `X-GitHub-Api-Version: ${GITHUB_WRITE_API_VERSION}`,
            '--',
            path,
          ],
          {
            env,
            cwd: dir,
            timeout: 15_000,
            killSignal: 'SIGKILL',
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024,
            encoding: 'utf8',
          },
          (error, result) => {
            if (error) reject(new GithubWriteFault('github_gh_read_failed'))
            else resolve(result)
          },
        )
      })
      return object(parseExternalGithubJson(stdout))
    })
  } catch (error) {
    if (error instanceof GithubWriteFault) throw error
    throw new GithubWriteFault('github_gh_read_failed')
  } finally {
    for (const socket of sockets) socket.destroy()
    proxy.close()
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
