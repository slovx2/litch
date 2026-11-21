import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type RequestListener } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
  downloadGithubCli,
  githubCliAsset,
  MANAGED_GITHUB_CLI_VERSION,
} from '../src/external/github/gh-download.mjs'
import { extractGithubCli, ManagedGithubCli } from '../src/external/github/gh-install.mjs'

function fixture(
  t: TestContext,
  platform: 'linux' | 'darwin' | 'win32' = 'linux',
  version = MANAGED_GITHUB_CLI_VERSION,
) {
  const root = mkdtempSync(join(tmpdir(), 'litch-gh-install-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 2 }))
  const { filename } = githubCliAsset(platform, 'x64')
  const name = filename.replace(/\.(zip|tar\.gz)$/, '')
  const binary = platform === 'win32' ? 'gh.exe' : 'gh'
  const packageDir = join(root, name)
  const archive = join(root, filename)
  mkdirSync(join(packageDir, 'bin'), { recursive: true })
  const executable = `#!/bin/sh\nprintf 'gh version ${version} (fixture)\\n'\n`
  writeFileSync(join(packageDir, 'bin', binary), executable, { mode: 0o700 })
  writeFileSync(join(packageDir, 'LICENSE'), 'license fixture')
  writeFileSync(join(packageDir, 'unrelated'), 'must not be extracted')
  if (platform === 'linux') execFileSync('/usr/bin/tar', ['-czf', archive, name], { cwd: root })
  else execFileSync('/usr/bin/zip', ['-qr', archive, name], { cwd: root })
  const body = readFileSync(archive)
  return {
    root,
    filename,
    archive,
    binary,
    executable,
    body,
    sha256: createHash('sha256').update(body).digest('hex'),
  }
}

async function server(t: TestContext, respond: RequestListener) {
  const instance = createServer(respond)
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    instance.closeAllConnections()
    instance.close()
  })
  const address = instance.address()
  assert.ok(address && typeof address !== 'string')
  return { url: `http://127.0.0.1:${address.port}/`, instance }
}

function installer(f: ReturnType<typeof fixture>, base: string, sha256 = f.sha256) {
  return new ManagedGithubCli(f.root, undefined, {
    asset: { url: new URL(f.filename, base), filename: f.filename, sha256 },
    proxyEnv: {},
    backoffMs: 1,
  })
}

test('下载并校验 Linux tar.gz：并发只请求一次，取消一个等待者不影响其他等待者', async (t) => {
  if (process.platform === 'win32') return t.skip('使用 Unix 假 gh；Windows zip 结构单独覆盖')
  const f = fixture(t)
  let requests = 0
  const listener = await server(t, (request, response) => {
    requests++
    assert.equal(request.url, `/${f.filename}`)
    assert.equal(request.headers.authorization, undefined)
    setTimeout(() => response.end(f.body), 30)
  })
  const cli = installer(f, listener.url)
  const ctrl = new AbortController()
  const canceled = cli.ensure(() => ctrl.abort(new Error('fixture canceled')), ctrl.signal)
  const statuses: string[] = []
  const successes = Promise.all(
    Array.from({ length: 5 }, () => cli.ensure(() => statuses.push('download'))),
  )
  await assert.rejects(canceled, /fixture canceled/)
  assert.equal((await successes).length, 5)
  assert.deepEqual(statuses, Array(5).fill('download'))
  assert.equal(requests, 1)
  assert.equal(
    await cli.ensure(() => assert.fail('cache must not download')),
    realpathSync(cli.path),
  )
  assert.equal(readFileSync(cli.path, 'utf8'), f.executable)
  assert.equal(readFileSync(join(dirname(dirname(cli.path)), 'LICENSE'), 'utf8'), 'license fixture')
  assert.equal(existsSync(join(dirname(dirname(cli.path)), 'unrelated')), false)
  assert.deepEqual(readdirSync(join(f.root, 'tools', 'github-cli')), [MANAGED_GITHUB_CLI_VERSION])
})

test('Windows zip 只提取指定的 gh.exe 与许可证', async (t) => {
  if (process.platform === 'win32') return t.skip('归档生成使用 Unix zip')
  const f = fixture(t, 'win32')
  const listener = await server(t, (_request, response) => response.end(f.body))
  const archive = join(f.root, 'downloaded.zip')
  await downloadGithubCli(
    { url: new URL(f.filename, listener.url), sha256: f.sha256 },
    archive,
    new AbortController().signal,
    {},
  )
  const output = join(f.root, 'installed', 'bin', f.binary)
  await extractGithubCli(archive, f.filename, output)
  assert.equal(readFileSync(output, 'utf8'), f.executable)
  assert.deepEqual(readdirSync(join(f.root, 'installed')).sort(), ['LICENSE', 'bin'])
})

test('错误哈希不重试，不执行 payload 或发布缓存；版本核验失败也移除发布目录', async (t) => {
  if (process.platform === 'win32') return t.skip('使用 Unix 假 gh')
  const f = fixture(t, 'linux', '9.9.9')
  let requests = 0
  const listener = await server(t, (_request, response) => {
    requests++
    response.end(f.body)
  })
  const badHash = installer(f, listener.url, '0'.repeat(64))
  await assert.rejects(badHash.ensure(), /github_gh_download_checksum/)
  assert.equal(requests, 1)
  assert.equal(existsSync(badHash.path), false)
  const wrongVersion = installer(f, listener.url)
  await assert.rejects(wrongVersion.ensure(), /github_gh_version_mismatch/)
  assert.equal(requests, 2)
  assert.equal(existsSync(dirname(dirname(wrongVersion.path))), false)
  assert.deepEqual(readdirSync(join(f.root, 'tools', 'github-cli')), [MANAGED_GITHUB_CLI_VERSION])
})

test('半截下载会清理并重试，连接拒绝耗尽次数后回报稳定错误码', async (t) => {
  if (process.platform === 'win32') return t.skip('使用 Unix 假 gh')
  const f = fixture(t)
  let requests = 0
  const listener = await server(t, (_request, response) => {
    if (++requests !== 1) {
      response.end(f.body)
      return
    }
    response.writeHead(200, { 'Content-Length': f.body.length })
    response.write(f.body.subarray(0, 20), () => response.destroy())
  })
  assert.ok(await installer(f, listener.url).ensure())
  assert.equal(requests, 2)
  const disconnected = await server(t, () => assert.fail('服务已离线'))
  await new Promise<void>((resolve) => disconnected.instance.close(() => resolve()))
  const destination = join(f.root, 'offline.part')
  await assert.rejects(
    downloadGithubCli(
      { url: new URL(disconnected.url), sha256: f.sha256 },
      destination,
      new AbortController().signal,
      {},
      1,
    ),
    /github_gh_download_unavailable/,
  )
  assert.equal(existsSync(destination), false)
})

test('遵守 HTTP_PROXY / HTTPS_PROXY 和 NO_PROXY，HTTPS 经 CONNECT 且无 GitHub 令牌', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'litch-gh-proxy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const body = 'proxy fixture'
  const sha256 = createHash('sha256').update(body).digest('hex')
  const origin = await server(t, (_req, res) => res.end(body))
  let proxied = 0
  const proxy = await server(t, (req, res) => {
    proxied++
    assert.equal(req.url, origin.url)
    res.end(body)
  })
  const signal = new AbortController().signal
  const asset = { url: new URL(origin.url), sha256 }
  await downloadGithubCli(asset, join(root, 'proxied'), signal, { HTTP_PROXY: proxy.url }, 1)
  await downloadGithubCli(
    asset,
    join(root, 'bypass'),
    signal,
    { HTTP_PROXY: proxy.url, NO_PROXY: '127.0.0.1' },
    1,
  )
  assert.equal(proxied, 1)
  let connects = 0
  proxy.instance.on('connect', (req, socket) => {
    connects++
    assert.equal(req.url, 'github.com:443')
    assert.equal(req.headers.authorization, undefined)
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n')
  })
  await assert.rejects(
    downloadGithubCli(
      githubCliAsset('linux', 'x64'),
      join(root, 'https'),
      signal,
      { HTTPS_PROXY: proxy.url },
      1,
    ),
    /github_gh_download_unavailable/,
  )
  assert.equal(connects, 3)
})

test('只在确认退出无使用者后清理较旧缓存；使用中和较新的版本保留', async (t) => {
  if (process.platform === 'win32') return t.skip('使用 Unix 假 gh')
  const f = fixture(t)
  const listener = await server(t, (_req, res) => res.end(f.body))
  const cache = join(f.root, 'tools', 'github-cli')
  for (const version of ['2.99.0', '2.101.0', '3.0.0']) {
    mkdirSync(join(cache, version), { recursive: true, mode: 0o700 })
    if (version !== '2.101.0') writeFileSync(join(cache, version, '.retired-safe'), '')
  }
  const cli = installer(f, listener.url)
  await cli.ensure()
  assert.equal(existsSync(join(cache, '2.99.0')), false)
  assert.equal(existsSync(join(cache, '2.101.0')), true)
  assert.equal(existsSync(join(cache, '3.0.0')), true)
  const marker = join(cache, MANAGED_GITHUB_CLI_VERSION, '.retired-safe')
  cli.abort()
  await cli.retire(false)
  assert.equal(existsSync(marker), false)
  await cli.retire(true)
  assert.equal(existsSync(marker), true)
  await installer(f, listener.url).ensure()
  assert.equal(existsSync(marker), false)
})
